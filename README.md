# 🏒 Mickey vs Amanda — Air Hockey

A tiny, serverless, real-time multiplayer air-hockey game. Two people on
two different computers play against each other in the browser. No backend,
no database, no build step — just three static files, perfect for GitHub Pages.

## How multiplayer works (no server needed)

Real-time play uses **WebRTC** peer-to-peer via [PeerJS](https://peerjs.com/)'s
free public signaling broker:

1. One player picks a character and taps **Create a game** → gets a 4-letter code.
2. The other player picks a character, types the code, and taps **Join**.
3. The browsers connect directly to each other and the match starts.

The player who created the game is the **authoritative host**: it runs the
puck physics and keeps score, and streams the game state ~60×/second. The
guest sends only its paddle position and sees the board rotated 180°, so
**each player controls the paddle at the bottom of their own screen**.

> Note: PeerJS's public broker is free but best-effort. If you ever want
> rock-solid uptime you can run your own PeerServer, but for casual play the
> public one is fine.

## Add the avatars

Drop two square PNGs into `assets/`:

```
assets/mickey.png
assets/amanda.png
```

Until they exist, each paddle shows a coloured disc with the character's
initial — the game works either way.

## Run locally

Because it uses ES features and image loading, open it through a local
server (not `file://`):

```bash
cd mickey-vs-amanda
python3 -m http.server 8000
# then open http://localhost:8000 in two browser windows/computers
```

To test multiplayer on one machine, open the page in two separate browser
windows: create a game in one, join with the code in the other.

## Deploy to GitHub Pages

1. Create a new GitHub repo (e.g. `air-hockey`) and push these files to it:

   ```bash
   cd mickey-vs-amanda
   git init
   git add .
   git commit -m "Air hockey game"
   git branch -M main
   git remote add origin https://github.com/<you>/air-hockey.git
   git push -u origin main
   ```

2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from
   a branch**, pick branch `main`, folder `/ (root)`, then **Save**.

3. Wait ~1 minute. Your game is live at
   `https://<you>.github.io/air-hockey/`.

Share that URL with the other player and you're set. 🎉

## Files

| File          | Purpose                                            |
|---------------|----------------------------------------------------|
| `index.html`  | Menu, lobby, and game screens                      |
| `style.css`   | All styling                                        |
| `game.js`     | Game physics, rendering, and P2P networking        |
| `assets/`     | `mickey.png` / `amanda.png` avatar photos          |

## Tweaks

Open `game.js` and edit the constants near the top:

- `WIN_SCORE` — points needed to win (default 7)
- `MAX_SPEED` — puck speed cap
- `PADDLE_R` / `PUCK_R` — paddle / puck sizes
- `GOAL_W` — width of the goal opening
