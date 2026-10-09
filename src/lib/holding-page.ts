/**
 * Shown instead of a crash when the app is running without a database.
 *
 * That happens on a preview host such as Vercel: the web app deploys fine, but the product
 * needs Postgres and a background worker, so every page that touches data would fail with a
 * 500. A plain explanation is the honest answer to anyone who opens the link.
 *
 * Static markup only: nothing here comes from a request, so there is nothing to escape.
 */
export const HOLDING_PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>NIT Care Ops</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #f6f7f9; color: #16202c;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  main {
    width: 100%; max-width: 560px; background: #fff; border: 1px solid #e3e6eb; border-radius: 14px;
    padding: 36px 32px;
  }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
  .mark {
    width: 38px; height: 38px; border-radius: 10px; background: #0f766e; color: #fff;
    display: grid; place-items: center; font-weight: 700;
  }
  .brand b { font-size: 15px; }
  h1 { font-size: 22px; line-height: 1.3; margin: 0 0 12px; letter-spacing: -0.01em; }
  p { margin: 0 0 14px; color: #44505f; }
  ul { list-style: none; padding: 0; margin: 22px 0; border-top: 1px solid #eceef2; }
  li {
    display: flex; justify-content: space-between; gap: 16px; padding: 11px 0;
    border-bottom: 1px solid #eceef2; font-size: 14.5px;
  }
  li span:last-child { font-weight: 600; }
  .ok { color: #15803d; }
  .off { color: #b45309; }
  small { display: block; margin-top: 22px; color: #6b7686; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="brand"><div class="mark">N</div><b>NIT Care Ops</b></div>
  <h1>This preview has no database attached</h1>
  <p>
    NIT Care Ops handles a hospital's patient communication: enquiries, appointment booking,
    WhatsApp confirmations and reminders, no-show recovery and discharge follow-up.
  </p>
  <p>
    It needs a database and an always-on background worker, so it runs on a dedicated server
    rather than on this preview host.
  </p>
  <ul>
    <li><span>Application</span><span class="ok">Deployed</span></li>
    <li><span>Database</span><span class="off">Not attached</span></li>
    <li><span>Background worker</span><span class="off">Not running</span></li>
  </ul>
  <small>Demonstration hospital with fictional data. No patient information is stored here.</small>
</main>
</body>
</html>`;
