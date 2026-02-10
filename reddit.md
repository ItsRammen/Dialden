# ToastTV: A Raspberry Pi that plays cartoons like it's 1995

My kids argue about what to watch. Prime has infinite choice and most of it is meh. YouTube is... let's not go there. And here's the thing: I'm French speaking, living in Germany, and every streaming service here only offers German. I just wanted my kids to watch French cartoons without navigating menus, apps, and parental controls.

So I started thinking about how TV used to work as a kid. You turned it on. Something was playing. You watched it or you didn't. No menus, no decisions, no negotiations with a five-year-old about why we can't watch *that* one.

## The inspiration

I found Captain Touch's [TV Time Machine](https://quarters.captaintouch.com/blog/posts/2025-09-20-tv-time-machine-a-raspberry-pi-that-plays-random-90s-tv.html) a while back, a Raspberry Pi that boots into random 90s shows. I loved the idea and started experimenting with something similar: streaming from a Pi 4 to a Fire TV Stick.

It worked, technically. But every time I wanted to use it, I had to navigate the Fire TV menu, unlock parental controls, open VLC, find the network stream. Too many steps. I didn't want an app. I didn't want a UI. I just wanted to pick up the remote and turn on the TV.

So I bought a second Pi (a Zero 2 W, because I didn't want to move my Pi 4 😬) and connected it directly to the TV. Local files, no network dependency. Just boot and play.

## What it does

[ToastTV](https://toasttv.eu) shuffles through a folder of videos, playing them randomly on a loop. When you turn on the TV, something is already playing.

The randomness solves the arguing problem: no one picks, so no one complains. There's a daily quota, so when time's up, it signs off automatically. No more "just one more episode" negotiations. HDMI-CEC means the actual TV remote handles play/pause and skip.

Then I got a bit carried away. I started thinking about what made the 90s TV experience feel so "cosy": the little logo in the corner, the bumper cartoons between shows, the seasonal details. 
I have precisely zero motion design skills, but I used Google Whisk to generate around 20 short clips of mascots I called "Penny & Chip". They greet the kids, wave goodbye when the quota runs out, and sleep on a loop when the TV is "off air".

The dashboard is a simple web page I can open on my computer or phone to manage the library, see what's playing, or manually trigger a sign-off, or extension.

## The tech

TypeScript and Bun for the daemon and dashboard. MPV for playback, it's fast, hardware-accelerated, and plays everything without transcoding. Systemd runs it as a service that survives reboots. Nothing clever.

## Current state

It runs on my Pi Zero 2 W. Should work on Pi 3, 4, and 5 as well. One command to install:

```
curl -sL toasttv.eu/install.sh | sudo bash
```

It's open source. I'm still figuring out what to add next. Perhaps I'll play with the streaming idea again 😏
