// Voice remote: pick a session, hold Space to record, review the transcript, Enter sends.
// Replies beep and wait for P. Nothing is read aloud on its own.
// Claude's questions wait in an inbox (I). An answer is bound to the question it was recorded for.
// Settings come over USB from bin/provision.py and live in NVS, never in source.
#include <M5Cardputer.h>
#include <LittleFS.h>
#include <WiFi.h>
#include <ESPmDNS.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include <map>
#include <esp_system.h>

static constexpr uint32_t RATE = 16000;
// 30 s is one whisper window. The LittleFS area is 1.5 MB, so a 960 KB clip fits next to the reply cache.
static constexpr uint32_t MAX_MS = 30000;
static constexpr size_t CHUNK = 1024;  // samples per buffer
static constexpr int NBUF = 3;         // the mic and speaker queue up to two buffers ahead
static const char *PATH = "/rec.wav";
static const char *REPLY_PATH = "/reply.wav";

static int16_t bufs[NBUF][CHUNK];

struct Config { String ssid, pass, host, token, ca, mdns; uint16_t port = 8443; } cfg;

// Known Wi-Fi networks, newest first. host is the bridge IP last seen on that network.
struct Net { String ssid, pass, host; };
static std::vector<Net> nets;
static constexpr size_t MAX_NETS = 3;

struct Session { String sid, label, branch, shortId; };
static std::vector<Session> sessions;
static int picked = 0;
static Session target;  // fixed when recording starts

enum State { NO_CONFIG, CONNECTING, PICKER, READY, REVIEW, SENT, INBOX, QUESTION, STATUS_VIEW };
static State state = NO_CONFIG;
static String note = "";
static String jobId, transcript, requestId, messageId, msgState, replyText, replyAudio;
static long cursor = 0;
static uint32_t lastPoll = 0, sentAt = 0;

struct Question { String qid, sid, label, branch, shortId, text, screen, audio; };
static std::vector<Question> inbox;
static int qPicked = 0;
static Question activeQ;
static bool answering = false, sentAnswer = false;

static bool quiet = false;          // no beeps; the inbox and badge still update
static String filter = "";          // picker shows sessions whose name contains this
static bool filtering = false;
static int lastCode = 0, pollFails = 0;
// Boot and Wi-Fi drop counters, to tell a reboot from a dropped connection. Sent to the bridge as headers.
static uint32_t bootCount = 0, wifiDrops = 0, lastDropMs = 0;
static int lastDropReason = 0;
static String resetName;
static uint32_t lastMs = 0;
static String bridgeStatus = "";
static State statusBack = PICKER;

// The last message and reply of each session, so switching sessions never shows another session's reply.
struct Last { String label, messageId, msgState, replyText, replyAudio; uint32_t sentAt; };
static std::map<String, Last> lasts;

static void switchTo(const Session &s) {
  if (s.sid == target.sid) return;
  if (target.sid.length()) lasts[target.sid] = {target.label, messageId, msgState, replyText, replyAudio, sentAt};
  target = s;
  Last l = lasts.count(s.sid) ? lasts[s.sid] : Last{};
  lasts.erase(s.sid);
  messageId = l.messageId; msgState = l.msgState; replyText = l.replyText; replyAudio = l.replyAudio; sentAt = l.sentAt;
  LittleFS.remove(REPLY_PATH);  // the cached audio belongs to the session we left
}

static bool anyPending() {
  if (messageId.length() && !replyText.length()) return true;
  for (auto &kv : lasts) if (kv.second.messageId.length() && !kv.second.replyText.length()) return true;
  return false;
}

// ---------- display ----------
static auto &D = M5Cardputer.Display;

static void header(const char *title) {
  D.fillScreen(BLACK);
  D.setTextSize(1);
  D.setTextColor(CYAN);
  D.setCursor(4, 4);
  D.print(title);
  if (!inbox.empty()) {
    D.setTextColor(BLACK, YELLOW);
    D.setCursor(128, 4);
    D.printf(" ? %d ", (int)inbox.size());
    D.setTextColor(WHITE, BLACK);
  }
  D.setTextColor(DARKGREY);
  D.setCursor(164, 4);
  D.print(quiet ? "q " : "  ");
  if (WiFi.status() != WL_CONNECTED) D.print("no wifi");
  else if (pollFails >= 2) { D.setTextColor(RED); D.print("no bridge"); }
  else D.print("wifi ok");
  D.drawFastHLine(0, 15, 240, DARKGREY);
  D.setCursor(4, 20);
  D.setTextColor(WHITE);
}

static void footer(const char *text) {
  D.setTextColor(DARKGREY);
  D.setCursor(4, 125);
  D.print(text);
}

static void noteLine() {
  if (!note.length()) return;
  D.setTextColor(YELLOW);
  D.setCursor(4, 112);
  D.print(note);
}

static String targetName(const Session &s) {
  return s.label + (s.branch.length() ? " (" + s.branch + ")" : "") + " " + s.shortId;
}

static std::vector<int> visible() {
  std::vector<int> v;
  String f = filter;
  f.toLowerCase();
  for (size_t i = 0; i < sessions.size(); i++) {
    String n = targetName(sessions[i]);
    n.toLowerCase();
    if (!f.length() || n.indexOf(f) >= 0) v.push_back(i);
  }
  return v;
}

static void draw() {
  switch (state) {
    case NO_CONFIG:
      header("Voice remote");
      D.println("Not set up.\n\nPlug into the laptop and run:\nbin/provision.py");
      break;
    case CONNECTING:
      header("Voice remote");
      D.printf("Connecting to %s ...", cfg.ssid.c_str());
      break;
    case PICKER:
    {
      header("Pick a session");
      auto v = visible();
      if (filter.length() || filtering) {
        D.setTextColor(YELLOW);
        D.printf("Filter: %s%s\n", filter.c_str(), filtering ? "_" : "");
        D.setTextColor(WHITE);
      }
      if (sessions.empty()) D.println("No live sessions.\nStart one with claude-remote.");
      else if (v.empty()) D.println("No session matches.");
      for (size_t i = 0; i < v.size() && i < 7; i++) {
        D.setTextColor((int)i == picked ? BLACK : WHITE, (int)i == picked ? WHITE : BLACK);
        D.printf(" %s \n", targetName(sessions[v[i]]).substring(0, 38).c_str());
      }
      D.setTextColor(WHITE, BLACK);
      noteLine();
      footer(filtering ? "type  Del: erase  Enter: done  `: clear" : ";. move Enter pick /filter R S");
      break;
    }
    case READY:
      header("Ready");
      D.println("Target:");
      D.setTextColor(GREEN);
      D.println(targetName(target));
      D.setTextColor(WHITE);
      D.println("\nHold Space and speak (30 s max).");
      if (replyText.length()) {
        D.setTextColor(YELLOW);
        D.println("\nLast reply:");
        D.setTextColor(WHITE);
        D.println(replyText.substring(0, 120));
      }
      noteLine();
      footer(replyAudio.length() ? "Spc talk P play I inbox S D Del" : "Space talk  I inbox  S stat  D quiet");
      break;
    case REVIEW:
      header(answering ? "Send this answer?" : "Send this?");
      D.setTextColor(GREEN);
      D.printf("To %s\n", targetName(target).c_str());
      if (answering) { D.setTextColor(DARKGREY); D.println(activeQ.screen.substring(0, 76)); }
      D.println();
      D.setTextColor(WHITE);
      D.setTextWrap(true);
      D.println(transcript.substring(0, 400));
      noteLine();
      footer("Enter: send   `: cancel");
      break;
    case SENT:
      header(msgState == "unknown" ? "Delivery uncertain" : sentAnswer ? "Answer sent" : "Sent");
      D.setTextColor(GREEN);
      D.printf("To %s\n", targetName(target).c_str());
      D.setTextColor(WHITE);
      if (msgState == "unknown") D.println("\nCheck the session on the laptop.\nNot resending.");
      else if (msgState != "delivered") D.println("\nSending...");
      else if (!replyText.length() && sentAnswer) D.println("\nDelivered to Claude's question.\nClaude carries on in the session.");
      else if (!replyText.length() && millis() - sentAt > 120000) D.println("\nDelivered. No voice reply yet.\nCheck the session on the laptop.");
      else if (!replyText.length()) D.println("\nDelivered. Waiting for a reply.\nClaude keeps working if you leave.");
      else { D.setTextColor(YELLOW); D.println("\nReply:"); D.setTextColor(WHITE); D.println(replyText.substring(0, 400)); }
      noteLine();
      footer(replyAudio.length() ? "P: play   other key: back" : "Any key: back");
      break;
    case INBOX:
      header("Questions");
      if (inbox.empty()) D.println("No open questions.");
      for (size_t i = 0; i < inbox.size() && i < 7; i++) {
        D.setTextColor((int)i == qPicked ? BLACK : WHITE, (int)i == qPicked ? WHITE : BLACK);
        D.printf(" %s: %s \n", inbox[i].label.substring(0, 12).c_str(), inbox[i].screen.substring(0, 24).c_str());
      }
      D.setTextColor(WHITE, BLACK);
      noteLine();
      footer("; . move  Enter open  `: back");
      break;
    case QUESTION:
      header("Claude asks");
      D.setTextColor(GREEN);
      D.printf("%s %s\n\n", activeQ.label.c_str(), activeQ.shortId.c_str());
      D.setTextColor(WHITE);
      D.println(activeQ.text.substring(0, 300));
      noteLine();
      footer(activeQ.audio.length() ? "Space: answer  P: play  `: back" : "Space: answer  `: back");
      break;
    case STATUS_VIEW:
      header("Status");
      D.printf("Wi-Fi %s %s\n", WiFi.status() == WL_CONNECTED ? cfg.ssid.c_str() : "down", WiFi.status() == WL_CONNECTED ? (String(WiFi.RSSI()) + " dBm").c_str() : "");
      D.printf("Me %s\n", WiFi.localIP().toString().c_str());
      D.print("Known:");
      for (auto &n : nets) D.printf(" %s", n.ssid.c_str());
      D.println();
      D.printf("Bridge %s:%u\n", cfg.host.c_str(), cfg.port);
      D.printf("Last call %d in %lu ms, fails %d\n", lastCode, (unsigned long)lastMs, pollFails);
      D.println(bridgeStatus.length() ? bridgeStatus : String("Bridge status unknown"));
      D.printf("Boot %lu (%s) up %lu s\n", (unsigned long)bootCount, resetName.c_str(), (unsigned long)(millis() / 1000));
      if (wifiDrops) D.printf("Drops %lu, last code %d, %lu s ago\n", (unsigned long)wifiDrops, lastDropReason, (unsigned long)((millis() - lastDropMs) / 1000));
      else D.println("Wi-Fi drops 0");
      D.printf("Heap %u free, %u min\n", ESP.getFreeHeap(), ESP.getMinFreeHeap());
      D.printf("Flash %u/%u KB  cursor %ld\n", (unsigned)(LittleFS.usedBytes() / 1024), (unsigned)(LittleFS.totalBytes() / 1024), cursor);
      D.printf("Quiet %s  Questions %d\n", quiet ? "on" : "off", (int)inbox.size());
      footer("R: refresh  `: back");
      break;
  }
}

// ---------- settings ----------
static void loadConfig() {
  Preferences p;
  p.begin("vr", true);
  nets.clear();
  JsonDocument d;
  if (!deserializeJson(d, p.getString("nets", "[]"))) for (JsonObject n : d.as<JsonArray>()) nets.push_back({ n["s"] | "", n["p"] | "", n["h"] | "" });
  // Settings from before multi-network provisioning.
  if (nets.empty() && p.getString("ssid", "").length()) nets.push_back({ p.getString("ssid", ""), p.getString("pass", ""), p.getString("host", "") });
  cfg.mdns = p.getString("mdns", "");
  cfg.port = p.getUShort("port", 8443);
  cfg.token = p.getString("token", "");
  cfg.ca = p.getString("ca", "");
  quiet = p.getBool("quiet", false);
  p.end();
}

static void saveNets(Preferences &p) {
  JsonDocument d;
  JsonArray a = d.to<JsonArray>();
  for (auto &n : nets) { JsonObject o = a.add<JsonObject>(); o["s"] = n.ssid; o["p"] = n.pass; o["h"] = n.host; }
  String out;
  serializeJson(d, out);
  p.putString("nets", out);
}

// One line over USB: VRCFG {"net":{"s":..,"p":..,"h":..},"forget":..,"mdns":..,"port":..,"token":..,"ca":..}
static void checkProvision() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n') { if (line.length() < 6000) line += c; continue; }
    if (line.startsWith("VRCFG ")) {
      JsonDocument doc;
      if (deserializeJson(doc, line.substring(6))) { Serial.println("VRCFG ERR json"); line = ""; continue; }
      Preferences p;
      p.begin("vr", false);
      // Only the keys sent change, so a token-only update keeps the Wi-Fi settings.
      for (const char *k : { "token", "ca", "mdns" }) if (doc[k].is<const char *>()) p.putString(k, doc[k].as<const char *>());
      String drop = doc["net"]["s"].is<const char *>() ? doc["net"]["s"].as<const char *>() : (doc["forget"] | "");
      if (drop.length()) {
        for (size_t i = 0; i < nets.size(); i++) if (nets[i].ssid == drop) { nets.erase(nets.begin() + i); break; }
        if (doc["net"]["s"].is<const char *>()) nets.insert(nets.begin(), { doc["net"]["s"] | "", doc["net"]["p"] | "", doc["net"]["h"] | "" });
        if (nets.size() > MAX_NETS) nets.resize(MAX_NETS);
        saveNets(p);
        p.remove("ssid"); p.remove("pass"); p.remove("host");
      }
      if (doc["port"].is<int>()) p.putUShort("port", doc["port"].as<int>());
      p.end();
      Serial.println("VRCFG OK");
      delay(200);
      ESP.restart();
    }
    line = "";
  }
}

// ---------- network ----------
// The laptop gets a new IP on each network. Ask for it by its .local name; the cert covers both.
static void resolveBridge() {
  if (!cfg.mdns.length()) return;
  IPAddress ip = MDNS.queryHost(cfg.mdns.c_str(), 1500);
  if (ip == IPAddress((uint32_t)0) || ip.toString() == cfg.host) return;
  cfg.host = ip.toString();
  for (auto &n : nets) if (n.ssid == cfg.ssid) n.host = cfg.host;
  Preferences p;
  p.begin("vr", false);
  saveNets(p);
  p.end();
}

static String resetReasonName() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "crash";
    case ESP_RST_INT_WDT: case ESP_RST_TASK_WDT: case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_DEEPSLEEP: return "deep-sleep";
    default: return String("code") + (int)esp_reset_reason();
  }
}

static void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  if (event != ARDUINO_EVENT_WIFI_STA_DISCONNECTED) return;
  wifiDrops++;
  lastDropMs = millis();
  lastDropReason = info.wifi_sta_disconnected.reason;
}

// Joins the strongest known network in range.
static bool connectWifi() {
  state = CONNECTING;
  cfg.ssid = "";
  draw();
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // modem sleep can drop the link while the mic and flash are busy
  WiFi.setAutoReconnect(true);
  int found = WiFi.scanNetworks();
  int best = -1, bestRssi = -1000;
  for (int i = 0; i < found; i++)
    for (int k = 0; k < (int)nets.size(); k++)
      if (WiFi.SSID(i) == nets[k].ssid && WiFi.RSSI(i) > bestRssi) { best = k; bestRssi = WiFi.RSSI(i); }
  WiFi.scanDelete();
  if (best < 0) { note = "No known Wi-Fi in range. R retries."; return false; }
  cfg.ssid = nets[best].ssid;
  cfg.pass = nets[best].pass;
  cfg.host = nets[best].host;
  draw();
  WiFi.begin(cfg.ssid.c_str(), cfg.pass.c_str());
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); checkProvision(); }
  if (WiFi.status() != WL_CONNECTED) return false;
  static bool mdnsUp = false;
  if (!mdnsUp) mdnsUp = MDNS.begin("voice-remote");
  resolveBridge();
  // TLS checks certificate dates, so the clock has to be right first.
  configTime(0, 0, "pool.ntp.org", "time.apple.com");
  for (int i = 0; i < 40 && time(nullptr) < 1700000000; i++) delay(250);
  return time(nullptr) >= 1700000000;
}

static WiFiClientSecure tls;

static int request(const char *method, const String &path, const String &body, String &out, File *file = nullptr) {
  if (WiFi.status() != WL_CONNECTED) { lastCode = -1; return -1; }
  uint32_t t0 = millis();
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(tls, cfg.host, cfg.port, path, true)) return -1;
  http.addHeader("Authorization", "Bearer " + cfg.token);
  http.addHeader("X-Boot", String(bootCount));
  http.addHeader("X-Reset", resetName);
  http.addHeader("X-Drops", String(wifiDrops));
  http.addHeader("X-Drop-Reason", String(lastDropReason));
  http.addHeader("X-Up", String(millis() / 1000));
  int code;
  if (file) {
    http.addHeader("Content-Type", "audio/wav");
    http.addHeader("X-Request-Id", requestId);
    http.addHeader("X-Target-Sid", target.sid);
    code = http.sendRequest(method, file, file->size());
  } else {
    if (body.length()) http.addHeader("Content-Type", "application/json");
    code = http.sendRequest(method, (uint8_t *)body.c_str(), body.length());
  }
  out = code > 0 ? http.getString() : "";
  http.end();
  lastCode = code;
  lastMs = millis() - t0;
  return code;
}

static String newId() {
  char b[25];
  snprintf(b, sizeof b, "%08lx%08lx%08lx", (unsigned long)esp_random(), (unsigned long)esp_random(), (unsigned long)esp_random());
  return b;
}

static void loadSessions() {
  String out;
  int code = request("GET", "/sessions", "", out);
  sessions.clear();
  if (code != 200) { note = code == 401 ? "Token rejected. Re-run provision." : "Bridge unreachable (" + String(code) + ")"; return; }
  JsonDocument doc;
  if (deserializeJson(doc, out)) { note = "Bad reply from bridge"; return; }
  for (JsonObject s : doc["sessions"].as<JsonArray>()) {
    sessions.push_back({ s["sid"] | "", s["label"] | "", s["branch"] | "", s["short"] | "" });
  }
  if (picked >= (int)sessions.size()) picked = 0;
  note = "";
  if (!cursor) {
    String ev;
    if (request("GET", "/events?after=0", "", ev) == 200) {
      JsonDocument e;
      if (!deserializeJson(e, ev)) cursor = e["latest"] | 0;
    }
  }
}

static void loadStatus() {
  String out;
  bridgeStatus = "";
  if (request("GET", "/status", "", out) != 200) return;
  JsonDocument d;
  if (deserializeJson(d, out)) return;
  bridgeStatus = String("Whisper ") + (d["whisper"] | "?") + ", " + (d["live_sessions"] | 0) + " live, up " + ((d["uptime_s"] | 0) / 60) + " min";
}

static void toggleQuiet() {
  quiet = !quiet;
  Preferences p;
  p.begin("vr", false);
  p.putBool("quiet", quiet);
  p.end();
  note = quiet ? "Quiet on. Inbox still updates." : "Quiet off.";
}

static void loadInbox() {
  String out;
  if (request("GET", "/questions", "", out) != 200) return;
  JsonDocument doc;
  if (deserializeJson(doc, out)) return;
  inbox.clear();
  for (JsonObject x : doc["questions"].as<JsonArray>()) {
    inbox.push_back({ x["question_id"] | "", x["sid"] | "", x["label"] | "", x["branch"] | "", x["short"] | "",
                      x["text"] | "", x["screen_text"] | "", x["audio_id"] | "" });
  }
  if (qPicked >= (int)inbox.size()) qPicked = 0;
}

// ---------- audio ----------
static void wavHeader(uint8_t *h, uint32_t dataBytes) {
  auto u32 = [&](int o, uint32_t v) { memcpy(h + o, &v, 4); };
  auto u16 = [&](int o, uint16_t v) { memcpy(h + o, &v, 2); };
  memcpy(h, "RIFF", 4); u32(4, 36 + dataBytes); memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4); u32(16, 16); u16(20, 1); u16(22, 1);
  u32(24, RATE); u32(28, RATE * 2); u16(32, 2); u16(34, 16);
  memcpy(h + 36, "data", 4); u32(40, dataBytes);
}

static void beep() {
  if (quiet) return;
  M5Cardputer.Mic.end();
  M5Cardputer.Speaker.begin();
  M5Cardputer.Speaker.setVolume(160);
  M5Cardputer.Speaker.tone(1800, 80);
  delay(120);
  M5Cardputer.Speaker.tone(2400, 80);
  delay(120);
  M5Cardputer.Speaker.end();
}

// Finds the data chunk instead of assuming a fixed 44-byte header. macOS speech adds a FLLR chunk.
static bool openWavData(File &f, uint32_t &rate, uint32_t &dataBytes) {
  uint8_t h[12];
  if (f.read(h, 12) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) return false;
  bool fmtOk = false;
  while (f.available() >= 8) {
    uint8_t c[8];
    f.read(c, 8);
    uint32_t len; memcpy(&len, c + 4, 4);
    if (!memcmp(c, "fmt ", 4)) {
      uint8_t fmt[16];
      if (len < 16 || f.read(fmt, 16) != 16) return false;
      uint16_t format, ch, bits;
      memcpy(&format, fmt, 2); memcpy(&ch, fmt + 2, 2); memcpy(&rate, fmt + 4, 4); memcpy(&bits, fmt + 14, 2);
      if (format != 1 || ch != 1 || bits != 16) return false;
      fmtOk = true;
      f.seek(f.position() + len - 16 + (len & 1));
    } else if (!memcmp(c, "data", 4)) {
      dataBytes = min<uint32_t>(len, f.available());
      return fmtOk;
    } else {
      f.seek(f.position() + len + (len & 1));
    }
  }
  return false;
}

// Returns false if playback was stopped with ESC.
static bool playFile(const char *path) {
  File f = LittleFS.open(path, "r");
  if (!f) return true;
  uint32_t rate = 0, left = 0;
  if (!openWavData(f, rate, left)) { f.close(); note = "Bad audio file"; return true; }
  M5Cardputer.Mic.end();
  M5Cardputer.Speaker.begin();
  M5Cardputer.Speaker.setVolume(255);
  // The amp needs about 200 ms after begin(). Without this lead-in the first sound of a reply is lost.
  static const int16_t lead[CHUNK] = {0};
  M5Cardputer.Speaker.playRaw(lead, CHUNK, rate, false, 4, 0, false);
  int i = 0;
  bool stopped = false;
  while (left > 0) {
    M5Cardputer.update();
    if (M5Cardputer.Keyboard.isKeyPressed('`')) { stopped = true; break; }
    size_t got = f.read((uint8_t *)bufs[i % NBUF], min<uint32_t>(left, CHUNK * 2));
    if (got < 2) break;
    left -= got;
    // playRaw keeps the pointer, so a buffer is reused only after two newer ones are queued.
    M5Cardputer.Speaker.playRaw(bufs[i % NBUF], got / 2, rate, false, 1, 0, false);
    i++;
  }
  if (stopped) M5Cardputer.Speaker.stop();
  while (M5Cardputer.Speaker.isPlaying()) { delay(1); M5Cardputer.update(); }
  f.close();
  M5Cardputer.Speaker.end();
  return !stopped;
}

static bool downloadAudio(const String &id) {
  LittleFS.remove(PATH);
  LittleFS.remove(REPLY_PATH);
  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(tls, cfg.host, cfg.port, "/audio/" + id, true)) return false;
  http.addHeader("Authorization", "Bearer " + cfg.token);
  int code = http.GET();
  if (code != 200) { http.end(); note = code == 404 ? "Audio expired" : "Audio download failed (" + String(code) + ")"; return false; }
  int total = http.getSize();
  if (total <= 0 || (size_t)total > LittleFS.totalBytes() - LittleFS.usedBytes() - 16 * 1024) { http.end(); note = "Reply audio too long, text only"; return false; }
  File f = LittleFS.open(REPLY_PATH, "w");
  WiFiClient *st = http.getStreamPtr();
  int got = 0;
  uint32_t lastData = millis();
  while (got < total && millis() - lastData < 5000) {
    int n = st->available();
    if (n <= 0) { delay(2); continue; }
    n = st->readBytes((uint8_t *)bufs[0], min<int>(n, CHUNK * 2));
    f.write((uint8_t *)bufs[0], n);
    got += n;
    lastData = millis();
  }
  f.close();
  http.end();
  if (got < total) { LittleFS.remove(REPLY_PATH); note = "Audio download cut off"; return false; }
  return true;
}

static void playReply() {
  if (!replyAudio.length()) return;
  header("Playing reply");
  D.println(replyText.substring(0, 400));
  footer("`: stop");
  if (!LittleFS.exists(REPLY_PATH) && !downloadAudio(replyAudio)) return;
  note = playFile(REPLY_PATH) ? "" : "Stopped. Claude's work is not affected.";
}

static void playQuestion() {
  header("Playing question");
  D.println(activeQ.text.substring(0, 300));
  footer("`: stop");
  LittleFS.remove(REPLY_PATH);  // shares the file with reply audio, which re-downloads when needed
  if (!downloadAudio(activeQ.audio)) { note = "Audio gone. Read the text."; return; }
  playFile(REPLY_PATH);
  LittleFS.remove(REPLY_PATH);
  note = "";
}

// Returns recorded seconds, or -1 on a write error.
static float record() {
  M5Cardputer.Speaker.end();
  auto mc = M5Cardputer.Mic.config();
  mc.magnification = 32;  // default 16 played back too quiet
  M5Cardputer.Mic.config(mc);
  M5Cardputer.Mic.begin();
  LittleFS.remove(PATH);
  size_t freeB = LittleFS.totalBytes() - LittleFS.usedBytes();
  if (freeB < MAX_MS / 1000 * RATE * 2 + 64 * 1024) LittleFS.remove(REPLY_PATH);  // re-downloads when P is pressed
  freeB = LittleFS.totalBytes() - LittleFS.usedBytes();
  uint32_t maxMs = min<uint32_t>(MAX_MS, freeB > 64 * 1024 ? (freeB - 64 * 1024) / (RATE * 2) * 1000 : 1000);
  File f = LittleFS.open(PATH, "w");
  if (!f) return -1;
  uint8_t hdr[44] = {0};
  f.write(hdr, 44);  // placeholder, rewritten once the length is known

  uint32_t start = millis(), bytes = 0, lastShown = 999;
  int i = 0, queued = 0;
  bool failed = false;
  header("Recording");
  D.setTextColor(GREEN);
  D.println(targetName(target));
  while (millis() - start < maxMs) {
    M5Cardputer.update();
    if (!M5Cardputer.Keyboard.keysState().space) break;
    M5Cardputer.Mic.record(bufs[i % NBUF], CHUNK, RATE);
    queued++;
    // Once record() returns for buffer i, buffer i-2 is finished.
    if (queued >= NBUF) {
      size_t w = f.write((uint8_t *)bufs[(i + 1) % NBUF], CHUNK * 2);
      if (w != CHUNK * 2) { failed = true; break; }
      bytes += w;
    }
    i++;
    uint32_t elapsed = millis() - start;
    uint32_t left = elapsed >= maxMs ? 0 : (maxMs - elapsed + 999) / 1000;
    if (left != lastShown) {
      lastShown = left;
      D.fillRect(0, 60, 240, 20, BLACK);
      D.setCursor(4, 64);
      D.setTextColor(RED);
      D.printf("REC  %lus left", (unsigned long)left);
    }
  }
  while (M5Cardputer.Mic.isRecording()) delay(1);
  for (int k = (queued >= NBUF ? NBUF - 1 : queued); k > 0 && !failed; k--) {
    size_t w = f.write((uint8_t *)bufs[(i - k + NBUF * 4) % NBUF], CHUNK * 2);
    if (w != CHUNK * 2) failed = true; else bytes += w;
  }
  wavHeader(hdr, bytes);
  f.seek(0);
  f.write(hdr, 44);
  f.close();
  M5Cardputer.Mic.end();
  return failed ? -1 : bytes / 2.0f / RATE;
}

// ---------- flow ----------
static void submitRecording() {
  requestId = newId();
  header("Transcribing");
  D.println("Uploading...");
  File f = LittleFS.open(PATH, "r");
  String out;
  int code = request("POST", "/voice/jobs", "", out, &f);
  f.close();
  State back = answering ? QUESTION : READY;
  if (code == 409) { note = "Session ended. Pick another."; answering = false; state = PICKER; loadSessions(); return; }
  if (code != 202 && code != 200) { note = "Upload failed (" + String(code) + "). Try again."; state = back; return; }
  JsonDocument doc;
  deserializeJson(doc, out);
  jobId = doc["job_id"] | "";
  D.println("Turning speech into text...");
  for (int i = 0; i < 120; i++) {
    delay(500);
    if (request("GET", "/voice/jobs/" + jobId, "", out) != 200) continue;
    JsonDocument j;
    if (deserializeJson(j, out)) continue;
    String status = j["status"] | "";
    if (status == "done") { transcript = j["transcript"] | ""; state = REVIEW; note = ""; return; }
    if (status == "failed") { note = String("Not understood: ") + (j["error"] | "error"); state = back; return; }
  }
  note = "Transcription timed out";
  state = back;
}

static void sendMessage() {
  JsonDocument doc;
  doc["sid"] = target.sid;
  doc["text"] = transcript;
  doc["idempotency_key"] = requestId;  // a retry after a timeout cannot send twice
  doc["job_id"] = jobId;
  String body, out;
  serializeJson(doc, body);
  int code = request("POST", "/messages", body, out);
  if (code == 409) { note = "Session ended. Not sent."; state = PICKER; loadSessions(); return; }
  if (code != 202 && code != 200) { note = "Not sent (" + String(code) + "). Enter retries."; return; }
  JsonDocument r;
  deserializeJson(r, out);
  messageId = r["message_id"] | "";
  msgState = r["state"] | "sending";
  replyText = "";
  replyAudio = "";
  LittleFS.remove(REPLY_PATH);
  note = "";
  sentAt = millis();
  sentAnswer = answering;
  answering = false;
  state = SENT;
}

static void sendAnswer() {
  JsonDocument doc;
  doc["text"] = transcript;
  doc["idempotency_key"] = requestId;
  doc["job_id"] = jobId;
  String body, out;
  serializeJson(doc, body);
  int code = request("POST", "/questions/" + activeQ.qid + "/answers", body, out);
  if (code == 409) {
    JsonDocument r;
    deserializeJson(r, out);
    String st = r["status"] | "";
    note = st == "answered" ? "Already answered. Not sent." : st == "expired" ? "Question expired. Not sent."
         : st == "cancelled" ? "Session ended. Not sent." : "Not sent (" + String(r["error"] | "conflict") + ")";
    answering = false;
    loadInbox();
    state = INBOX;
    return;
  }
  if (code != 202 && code != 200) { note = "Not sent (" + String(code) + "). Enter retries."; return; }
  JsonDocument r;
  deserializeJson(r, out);
  messageId = r["message_id"] | "";
  msgState = r["state"] | "sending";
  replyText = "";
  replyAudio = "";
  LittleFS.remove(REPLY_PATH);
  note = "";
  sentAt = millis();
  sentAnswer = true;
  answering = false;
  for (size_t i = 0; i < inbox.size(); i++) if (inbox[i].qid == activeQ.qid) { inbox.erase(inbox.begin() + i); break; }
  state = SENT;
}

static void pollSent() {
  // Back off while the bridge is unreachable: 3 s, 6 s, 12 s, up to 30 s.
  uint32_t every = pollFails ? min(30000u, 3000u << min(pollFails, 4)) : (anyPending() ? 2500u : 3000u);
  if (millis() - lastPoll < every) return;
  lastPoll = millis();
  String out;
  bool changed = false, inboxChanged = false, newQuestion = false;
  if (messageId.length() && msgState != "delivered" && msgState != "unknown" && request("GET", "/messages/" + messageId, "", out) == 200) {
    JsonDocument m;
    if (!deserializeJson(m, out) && String(m["state"] | "") != msgState) { msgState = m["state"] | ""; changed = true; }
  }
  int evCode = request("GET", "/events?after=" + String(cursor), "", out);
  int before = pollFails;
  pollFails = evCode == 200 ? 0 : pollFails + 1;
  // Moved to another network, or the laptop got a new address.
  if (pollFails == 2 || (pollFails > 2 && pollFails % 4 == 0)) {
    if (WiFi.status() != WL_CONNECTED && (state == PICKER || state == READY)) { State keep = state; connectWifi(); state = keep; changed = true; }
    else resolveBridge();
  }
  if ((before >= 2) != (pollFails >= 2)) changed = true;
  if (evCode == 200) {
    JsonDocument e;
    if (!deserializeJson(e, out)) {
      for (JsonObject ev : e["events"].as<JsonArray>()) {
        cursor = ev["event_id"] | cursor;
        String mid = ev["message_id"] | "";
        if (String(ev["type"] | "") == "reply" && mid.length() && mid == messageId && !replyText.length()) {
          replyText = ev["text"] | "";
          replyAudio = ev["audio_id"] | "";
          LittleFS.remove(REPLY_PATH);
          if (!replyAudio.length()) note = "No audio for this reply. Text only.";
          beep();
          changed = true;
        } else if (String(ev["type"] | "") == "reply") {
          for (auto &kv : lasts) {
            Last &l = kv.second;
            if (l.messageId != mid || l.replyText.length()) continue;
            l.replyText = ev["text"] | "";
            l.replyAudio = ev["audio_id"] | "";
            note = "Reply waiting in " + l.label + ".";
            beep();
            changed = true;
          }
        }
        if (String(ev["type"] | "") == "session_ended" && String(ev["sid"] | "") == target.sid) { note = "Session ended."; changed = true; }
        if (String(ev["type"] | "") == "question") { newQuestion = true; inboxChanged = true; }
        if (String(ev["type"] | "") == "question_closed" || String(ev["type"] | "") == "session_ended") inboxChanged = true;
      }
    }
  }
  if (inboxChanged) {
    loadInbox();
    changed = true;
    if (state == QUESTION) {
      bool open = false;
      for (auto &x : inbox) if (x.qid == activeQ.qid) open = true;
      if (!open) { note = "That question closed."; state = INBOX; }
    }
  }
  if (newQuestion) { note = "Claude has a question. Press I."; beep(); }
  if (changed && state != REVIEW) draw();
}

void setup() {
  auto c = M5.config();
  M5Cardputer.begin(c, true);
  D.setRotation(1);
  D.setFont(&fonts::Font0);
  Serial.setRxBufferSize(4096);  // the settings line with the CA is about 1 KB
  Serial.begin(115200);
  LittleFS.begin(true);
  loadConfig();
  {
    Preferences p;
    p.begin("vr", false);
    bootCount = p.getUInt("boots", 0) + 1;
    p.putUInt("boots", bootCount);
    p.end();
  }
  resetName = resetReasonName();
  WiFi.onEvent(onWifiEvent);
  if (nets.empty() || !cfg.ca.length() || !cfg.token.length()) { state = NO_CONFIG; draw(); return; }
  tls.setCACert(cfg.ca.c_str());
  if (!connectWifi()) { state = PICKER; if (!note.length()) note = "Wi-Fi or clock failed. R retries."; draw(); return; }
  state = PICKER;
  loadSessions();
  loadInbox();
  draw();
}

void loop() {
  checkProvision();
  M5Cardputer.update();
  if (state != NO_CONFIG && state != CONNECTING) pollSent();
  if (!M5Cardputer.Keyboard.isChange() || !M5Cardputer.Keyboard.isPressed()) { delay(10); return; }
  auto &ks = M5Cardputer.Keyboard.keysState();
  auto has = [&](char ch) { for (auto k : ks.word) if (k == ch) return true; return false; };

  switch (state) {
    case NO_CONFIG:
    case CONNECTING:
      break;
    case PICKER:
      if (filtering) {
        if (ks.enter) filtering = false;
        else if (has('`')) { filter = ""; filtering = false; }
        else if (ks.del) { if (filter.length()) filter.remove(filter.length() - 1); }
        else for (auto k : ks.word) if (k >= 32 && k < 127 && filter.length() < 20) filter += k;
        picked = 0;
        break;
      }
      if (has(';') && picked > 0) picked--;
      else if (has('.') && picked + 1 < (int)visible().size()) picked++;
      else if (has('/')) { filtering = true; picked = 0; }
      else if (has('d')) toggleQuiet();
      else if (has('s')) { statusBack = PICKER; loadStatus(); state = STATUS_VIEW; }
      else if (has('r') || has('R')) {
        if (WiFi.status() != WL_CONNECTED && !connectWifi()) { note = "Wi-Fi or clock failed"; state = PICKER; }
        else { resolveBridge(); state = PICKER; loadSessions(); }
      }
      else if (has('i')) { loadInbox(); note = ""; state = INBOX; }
      else if (ks.enter && !visible().empty()) { switchTo(sessions[visible()[picked]]); note = ""; state = READY; }
      break;
    case STATUS_VIEW:
      if (has('r')) loadStatus();
      else if (has('`')) state = statusBack;
      break;
    case READY:
      if (has('p') && replyAudio.length()) playReply();
      else if (ks.space) {
        float secs = record();
        if (secs < 0) note = "Flash write failed";
        else if (secs < 0.5f) note = "Too short. Hold Space while talking.";
        else submitRecording();
      } else if (ks.del) { state = PICKER; loadSessions(); }
      else if (has('i')) { loadInbox(); note = ""; state = INBOX; }
      else if (has('d')) toggleQuiet();
      else if (has('s')) { statusBack = READY; loadStatus(); state = STATUS_VIEW; }
      break;
    case REVIEW:
      if (ks.enter) answering ? sendAnswer() : sendMessage();
      else if (has('`')) { note = "Cancelled. Nothing sent."; state = answering ? QUESTION : READY; answering = false; }
      break;
    case INBOX:
      if (has(';') && qPicked > 0) qPicked--;
      else if (has('.') && qPicked + 1 < (int)inbox.size()) qPicked++;
      else if (ks.enter && !inbox.empty()) { activeQ = inbox[qPicked]; note = ""; state = QUESTION; }
      else if (has('`')) { note = ""; state = target.sid.length() ? READY : PICKER; }
      break;
    case QUESTION:
      if (has('p') && activeQ.audio.length()) playQuestion();
      else if (ks.space) {
        // The answer goes to the session that asked, whatever was selected before.
        switchTo({ activeQ.sid, activeQ.label, activeQ.branch, activeQ.shortId });
        answering = true;
        float secs = record();
        if (secs < 0) { note = "Flash write failed"; answering = false; }
        else if (secs < 0.5f) { note = "Too short. Hold Space while talking."; answering = false; }
        else submitRecording();
      } else if (has('`')) { note = ""; state = INBOX; }
      break;
    case SENT:
      if (has('p') && replyAudio.length()) { playReply(); break; }
      note = "";
      state = READY;
      break;
  }
  draw();
}
