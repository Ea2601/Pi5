#!/usr/bin/env python3
"""
Pimoroni Fan SHIM LED Control for Pi5
Controls the APA102 RGB LED on the Fan SHIM via SPI GPIO.

Usage:
  python3 led_control.py set "#3b82f6" 80 "static"
  python3 led_control.py set "#22c55e" 100 "breathe"
  python3 led_control.py off
  python3 led_control.py status

Requires: pip3 install fanshim
If fanshim not available, falls back to direct SPI via spidev/gpiod.
"""

import sys
import time
import json
import signal
import os

PID_FILE = "/tmp/led_control.pid"
STATE_FILE = "/tmp/led_state.json"


def hex_to_rgb(hex_color):
    """Convert hex color to (r, g, b) tuple."""
    hex_color = hex_color.lstrip('#')
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def save_state(color, brightness, animation, enabled):
    """Save current LED state for status reporting."""
    state = {"color": color, "brightness": brightness, "animation": animation, "enabled": enabled}
    try:
        with open(STATE_FILE, 'w') as f:
            json.dump(state, f)
    except:
        pass


def kill_existing():
    """Kill any running LED animation process."""
    try:
        if os.path.exists(PID_FILE):
            with open(PID_FILE) as f:
                old_pid = int(f.read().strip())
            os.kill(old_pid, signal.SIGTERM)
            time.sleep(0.2)
    except (ProcessLookupError, ValueError):
        pass
    finally:
        try:
            os.unlink(PID_FILE)
        except:
            pass


def write_pid():
    """Write current PID for future cleanup."""
    with open(PID_FILE, 'w') as f:
        f.write(str(os.getpid()))


def _ws2812_encode(count, r, g, b):
    """Encode one solid color for `count` WS2812 LEDs as an SPI byte stream.

    WS2812 has no clock line; the waveform is encoded on SPI MOSI. At 2.4 MHz each SPI
    bit is ~0.417us, so one 1.25us data bit = 3 SPI bits: '1'=0b110, '0'=0b100. Wire
    order is GRB. This is the Raspberry Pi 5 -compatible method (rpi_ws281x does NOT
    work on the Pi5's RP1); Pironman 5 and most addressable-RGB cases use WS2812.
    """
    data = bytearray()
    for _ in range(count):
        for byte in (g, r, b):  # GRB wire order
            bits = 0
            for i in range(7, -1, -1):
                bits = (bits << 3) | (0b110 if (byte >> i) & 1 else 0b100)
            data += bits.to_bytes(3, 'big')  # 24 SPI bits = 3 bytes per color byte
    return list(data)


class WS2812:
    def __init__(self, spi, count):
        self._spi = spi
        self._count = count

    def set_light(self, r, g, b, brightness=1.0):
        r = max(0, min(255, int(r * brightness)))
        g = max(0, min(255, int(g * brightness)))
        b = max(0, min(255, int(b * brightness)))
        payload = _ws2812_encode(self._count, r, g, b)
        # Trailing low bytes hold MOSI low >50us to latch the frame.
        self._spi.xfer2(payload + [0] * 16)


class DirectAPA102:
    def __init__(self, spi):
        self._spi = spi

    def set_light(self, r, g, b, brightness=1.0):
        # APA102 protocol: start frame + LED frame + end frame
        bright_byte = 0xE0 | int(max(0, min(31, brightness * 31)))
        self._spi.xfer2([0x00, 0x00, 0x00, 0x00])  # Start frame
        self._spi.xfer2([bright_byte, b, g, r])      # LED data (BGR order)
        self._spi.xfer2([0xFF, 0xFF, 0xFF, 0xFF])    # End frame


def get_led():
    """Return an LED controller. Order: Fan SHIM → WS2812/SPI (Pi5, Pironman 5) → APA102/SPI.

    Override via env: PI5_LED_TYPE=ws2812|apa102|fanshim|auto (default auto),
    PI5_LED_COUNT (default 4), PI5_LED_SPI_BUS (0), PI5_LED_SPI_DEV (0).
    """
    led_type = os.environ.get('PI5_LED_TYPE', 'auto').lower()
    try:
        count = int(os.environ.get('PI5_LED_COUNT', '4') or 4)
        bus = int(os.environ.get('PI5_LED_SPI_BUS', '0') or 0)
        dev = int(os.environ.get('PI5_LED_SPI_DEV', '0') or 0)
    except ValueError:
        count, bus, dev = 4, 0, 0

    # Pimoroni Fan SHIM (APA102 on its own pins)
    if led_type in ('auto', 'fanshim'):
        try:
            from fanshim import FanShim
            return FanShim()
        except Exception:
            # Paket yok VEYA donanım yok — sıradaki sürücüye düş
            pass

    # WS2812 addressable RGB over SPI (Pi5-compatible; Pironman 5 default)
    if led_type in ('auto', 'ws2812', 'ws281x', 'neopixel'):
        try:
            import spidev
            spi = spidev.SpiDev()
            spi.open(bus, dev)
            spi.max_speed_hz = 2400000
            spi.mode = 0
            return WS2812(spi, count)
        except Exception:
            pass

    # APA102 direct over SPI
    if led_type in ('auto', 'apa102'):
        try:
            import spidev
            spi = spidev.SpiDev()
            spi.open(bus, dev)
            spi.max_speed_hz = 1000000
            return DirectAPA102(spi)
        except Exception:
            pass

    return None


def set_static(led, r, g, b, brightness):
    """Set LED to a static color."""
    led.set_light(r, g, b, brightness=brightness)


def run_animation(led, r, g, b, brightness, animation):
    """Run LED animation loop (blocks until killed)."""
    write_pid()

    if animation == "static":
        set_static(led, r, g, b, brightness)
        # Stay alive so PID file remains valid
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            time.sleep(60)

    elif animation == "breathe":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            # Fade in
            for i in range(0, 100, 2):
                b_factor = (i / 100.0) * brightness
                led.set_light(r, g, b, brightness=b_factor)
                time.sleep(0.03)
            # Fade out
            for i in range(100, 0, -2):
                b_factor = (i / 100.0) * brightness
                led.set_light(r, g, b, brightness=b_factor)
                time.sleep(0.03)

    elif animation == "pulse":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            led.set_light(r, g, b, brightness=brightness)
            time.sleep(0.5)
            led.set_light(0, 0, 0, brightness=0)
            time.sleep(0.5)

    elif animation == "blink":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        while True:
            led.set_light(r, g, b, brightness=brightness)
            time.sleep(0.15)
            led.set_light(0, 0, 0, brightness=0)
            time.sleep(0.15)

    elif animation == "rainbow":
        signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
        hue = 0
        while True:
            # HSV to RGB (simple conversion)
            h = hue / 360.0
            i = int(h * 6)
            f = h * 6 - i
            q = 1 - f
            t = f
            if i % 6 == 0:
                cr, cg, cb = 1, t, 0
            elif i % 6 == 1:
                cr, cg, cb = q, 1, 0
            elif i % 6 == 2:
                cr, cg, cb = 0, 1, t
            elif i % 6 == 3:
                cr, cg, cb = 0, q, 1
            elif i % 6 == 4:
                cr, cg, cb = t, 0, 1
            else:
                cr, cg, cb = 1, 0, q

            led.set_light(int(cr * 255), int(cg * 255), int(cb * 255), brightness=brightness)
            hue = (hue + 2) % 360
            time.sleep(0.05)

    else:
        set_static(led, r, g, b, brightness)


def led_off(led):
    """Turn LED off."""
    kill_existing()
    try:
        led.set_light(0, 0, 0, brightness=0)
    except:
        pass
    save_state("#000000", 0, "off", False)


def main():
    if len(sys.argv) < 2:
        print("Usage: led_control.py [set|off|status] ...")
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "status":
        try:
            with open(STATE_FILE) as f:
                print(json.dumps(json.load(f)))
        except:
            print('{"enabled": false}')
        return

    led = get_led()
    if led is None:
        print("HATA: LED kontrol bulunamadi. fanshim veya spidev kurulu mu?", file=sys.stderr)
        print("Kurulum: pip3 install fanshim", file=sys.stderr)
        sys.exit(1)

    if cmd == "off":
        led_off(led)
        print("LED kapatildi")

    elif cmd == "set":
        if len(sys.argv) < 5:
            print("Usage: led_control.py set <hex_color> <brightness_0-100> <animation>")
            sys.exit(1)

        color = sys.argv[2]
        brightness = int(sys.argv[3]) / 100.0
        animation = sys.argv[4]

        r, g, b = hex_to_rgb(color)

        # Kill any existing animation
        kill_existing()

        # Save state
        save_state(color, int(brightness * 100), animation, True)

        if animation == "static":
            # For static, just set and exit (no daemon needed)
            set_static(led, r, g, b, brightness)
            print(f"LED: {color} brightness={int(brightness*100)}% animation=static")
        else:
            # Fork daemon for animations
            pid = os.fork()
            if pid > 0:
                # Parent exits
                print(f"LED: {color} brightness={int(brightness*100)}% animation={animation} (pid={pid})")
                return
            else:
                # Child runs animation
                os.setsid()
                run_animation(led, r, g, b, brightness, animation)

    else:
        print(f"Bilinmeyen komut: {cmd}")
        sys.exit(1)


if __name__ == "__main__":
    main()
