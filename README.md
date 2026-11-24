# Repost Cleaner

Clear your TikTok reposts in small batches. Everything runs on your device. No accounts, no servers, no subscriptions.

## Two parts

- **Dashboard** (GitHub Pages): your list of reposts, batch selection, progress, and CSV export. Open it in Safari on iPhone.
- **Bookmark** (runs on tiktok.com): scans your Reposts tab and removes the batch you copied from the dashboard.

They talk through the clipboard. The dashboard never touches your TikTok login.

## One-time setup (iPhone)

1. Open the dashboard, tap **Copy setup bookmark**.
2. In Safari, open any page, tap Share > **Add Bookmark**, name it *Repost Cleaner*.
3. Edit that bookmark and paste the copied text as its URL.

## Each session

1. On tiktok.com, open your **Reposts** tab, tap the bookmark. It scans and copies the list.
2. In the dashboard, tap **Read clipboard**.
3. Tap **Select next**, then **Copy batch to clipboard**.
4. Back on your Reposts tab, tap the bookmark. It removes the batch and copies results.
5. In the dashboard, tap **Read clipboard** again.

Test mode is on by default. It finds the control but does not click it. Run one batch in test mode, check the results, then turn test mode off.

## Status

Untested on a live account. The bookmark's removal step depends on TikTok's page layout, which can change. Expect to adjust selectors after the first real run.

## Build

```
npm install
npm run build   # outputs dist/ (dashboard + dist/bookmarklet.js)
```
