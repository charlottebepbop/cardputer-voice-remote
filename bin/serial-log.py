# Writes everything the Cardputer prints over USB to run/serial.log, with a time stamp per line.
# A panic prints a "Backtrace:" line there. Decode it with bin/decode-backtrace.sh.
# Opening the port restarts the device once. Leave this running while you use it.
# Run: uv run --with pyserial python -I bin/serial-log.py
import glob, os, sys, time
import serial

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
path = os.path.join(root, 'run', 'serial.log')
log = open(path, 'a', buffering=1)
print(f'Logging to {path}. Ctrl-C stops.', flush=True)
while True:
    ports = glob.glob('/dev/cu.usbmodem*')
    if not ports:
        time.sleep(1)
        continue
    try:
        with serial.Serial(ports[0], 115200, timeout=1) as s:
            log.write(f'{time.strftime("%FT%T")} --- port open {ports[0]}\n')
            while True:
                line = s.readline()
                if line:
                    log.write(f'{time.strftime("%FT%T")} {line.decode("utf-8", "replace").rstrip()}\n')
    except (serial.SerialException, OSError):
        log.write(f'{time.strftime("%FT%T")} --- port lost\n')
        time.sleep(1)
