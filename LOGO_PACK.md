# Logo pack v1 - Harsha's logo wired into the platform, BIG

His decisions, implemented as-is:
- The icon is his original image, never redrawn. In the app it is the cleaned
  high-resolution glass lift (mark-transparent-hq) shown LARGE: 52px in the
  sidebar brand (44px on phone), never compressed into small UI slots.
- The wordmark is his original slash form with the slash ~14% taller, grown
  upward from the baseline, L-to-A gap at his original tightness, set in
  Inter Tight Light beside the mark, tagline under it.
- The browser favicon is the black tile (glass on platform black) at
  512/180/32 - the one place a small rendition is unavoidable.

Files: web/src/App.tsx (brand block), web/src/assets/logo-glass.png,
web/src/vite-env.d.ts, web/index.html (favicon links, Inter Tight 300/500),
web/public/favicon-*.png, and the rebuilt frontend/react + frontend/index.html
(flip copy included). Suite after the change: 192 passed.
