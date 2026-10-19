# Adds the Wi-Fi the laptop is on now to the Cardputer and trusts it for the bridge listener.
# The device keeps 3 networks and joins the strongest one in range. Run it once per place.
# Also sends the device token and the bridge CA. Nothing secret is written to disk here.
# Run: uv run --with pyserial python -I bin/provision.py
#   --token-only     after bin/revoke-token: send only the new token
#   --forget NAME    remove a network from the device and from run/trusted-networks
import getpass, glob, json, os, subprocess, sys, time
import serial

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
trusted = os.path.join(root, 'run', 'trusted-networks')
ports = glob.glob('/dev/cu.usbmodem*')
if len(ports) != 1:
    sys.exit(f'Expected one Cardputer on USB, found {ports or "none"}.')
ca_path = os.path.join(root, 'run', 'tls', 'ca.pem')
if not os.path.exists(ca_path):
    sys.exit('No CA yet. Start the bridge once with bin/start-bridge.')


def read_trusted():
    if not os.path.exists(trusted):
        return []
    return [l.split(' ', 1) for l in open(trusted).read().splitlines() if ' ' in l]


def write_trusted(rows):
    with open(trusted, 'w') as f:
        f.write(''.join(f'{mac} {name}\n' for mac, name in rows))


token = open(os.path.join(root, 'run', 'device-token')).read().strip()
ip = ''
if '--token-only' in sys.argv:
    cfg = {'token': token}
elif '--forget' in sys.argv:
    name = sys.argv[sys.argv.index('--forget') + 1]
    cfg = {'forget': name}
    trust = [r for r in read_trusted() if r[1] != name]
else:
    ip = subprocess.run(['ipconfig', 'getifaddr', 'en0'], capture_output=True, text=True).stdout.strip()
    net_id = subprocess.run([os.path.join(root, 'bin', 'network-id')], capture_output=True, text=True).stdout.strip()
    if not ip or not net_id:
        sys.exit('The laptop is not on Wi-Fi. Join the network you want to add first.')
    print('Only add networks you control: home Wi-Fi or your phone hotspot. Never office or event Wi-Fi.')
    ssid = input('Name of the Wi-Fi the laptop is on now (2.4 GHz): ').strip()
    password = getpass.getpass('Wi-Fi password (not shown): ')
    host = subprocess.run(['scutil', '--get', 'LocalHostName'], capture_output=True, text=True).stdout.strip()
    cfg = {'net': {'s': ssid, 'p': password, 'h': ip}, 'mdns': host, 'port': 8443, 'token': token, 'ca': open(ca_path).read()}
    trust = [r for r in read_trusted() if r[0] != net_id and r[1] != ssid] + [[net_id, ssid]]

s = serial.Serial()
s.port, s.baudrate, s.timeout, s.dtr, s.rts = ports[0], 115200, 0.2, False, False
s.open()
# Opening the port can restart the device. Let it boot before sending.
time.sleep(4)
s.reset_input_buffer()
line = b'\nVRCFG ' + json.dumps(cfg).encode() + b'\n'
got = b''
for attempt in range(3):
    s.write(line)
    deadline = time.time() + 4
    while time.time() < deadline and b'VRCFG OK' not in got:
        got += s.read(256)
    if b'VRCFG OK' in got:
        break
s.close()
if b'VRCFG OK' in got:
    if '--token-only' not in sys.argv:
        write_trusted(trust)
        os.chmod(trusted, 0o600)
    msg = 'Saved the new token.' if '--token-only' in sys.argv else 'Removed.' if '--forget' in sys.argv else f'Saved and trusted. Bridge address {ip}:8443.'
    print(msg, 'The Cardputer restarts now.')
else:
    sys.exit(f'No confirmation from the device: {got[-200:]!r}')
