#!/bin/sh
# Turns the last "Backtrace:" line in run/serial.log into function names and source lines.
# Valid only for the firmware.elf built from the flashed source.
here=$(dirname "$(readlink -f "$0")")/..
elf="$here/firmware/.pio/build/cardputer-adv/firmware.elf"
tool="$HOME/.platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-addr2line"
grep -E "Guru Meditation|Backtrace:|abort\(\)|assert failed|Stack smashing|heap_caps" "$here/run/serial.log" | tail -6
addrs=$(grep "Backtrace:" "$here/run/serial.log" | tail -1 | sed 's/.*Backtrace://' | tr ' ' '\n' | grep -o '^0x[0-9a-f]*')
[ -n "$addrs" ] && "$tool" -pfiaC -e "$elf" $addrs
