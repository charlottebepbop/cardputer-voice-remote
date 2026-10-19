# Switching between networks

The Cardputer keeps up to 3 Wi-Fi networks and joins the strongest one in range.
It finds the laptop by its `.local` name, so a new laptop IP needs no reprovisioning.
The bridge listens only on networks in `run/trusted-networks`. It checks every 10 s, so it follows the laptop without a restart.

Add a network once, with the laptop on it and the Cardputer on USB:

    uv run --with pyserial python -I bin/provision.py

Only add networks you control: home Wi-Fi or your phone hotspot. Never office or event Wi-Fi.
macOS hides the Wi-Fi name from scripts, so `bin/network-id` names a network by its gateway MAC.

Remove one: `bin/provision.py --forget NAME`.
iPhone hotspot: turn on Maximize Compatibility. The Cardputer sees 2.4 GHz only.

## Live result (18 Oct 2026): passed

Home Wi-Fi (FRITZ!Box) to phone hotspot and back. The bridge followed the laptop with no restart.
The Cardputer joined the network in range with no reprovisioning. A voice message went through on the hotspot.
