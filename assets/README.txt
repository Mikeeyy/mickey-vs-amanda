Avatar images (512x512 PNG, clipped to a circle in-game).

Current roster:
    maju.png  miki.png  amanda.png  capibara.png  goliat.png  olaf.png

To ADD a new avatar:
  1. Drop a square PNG here named <key>.png  (e.g. rex.png)
  2. In game.js, add the key to the ROSTER array and a matching entry to
     the CHARS object (name + color + src). The picker builds itself from
     that list, so nothing else needs to change.

If an image is missing, the game falls back to a coloured disc showing the
character's initial — nothing breaks.
