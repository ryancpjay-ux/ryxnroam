# ryxnroam helpers

`ios_location_helper.py` is a separate program that ryxnroam starts to hold a simulated
location on iOS 17+ devices. It imports [pymobiledevice3](https://github.com/doronz88/pymobiledevice3),
so it is licensed **GPL-3.0-or-later** (full text in [COPYING](COPYING)). It is not linked into the
ryxnroam application, which stays MIT-licensed and talks to it only over stdin/stdout.

It runs with the same Python interpreter as your pymobiledevice3 install and needs nothing else.
