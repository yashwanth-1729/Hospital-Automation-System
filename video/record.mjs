// Records each scene of the pitch video from the live Clevo site, in high quality.
// A scripted browser clicks through at a calm pace with a smooth, visible cursor; frames are
// captured losslessly-ish from Chrome (CDP screencast) and stitched with ffmpeg.
//
//   node record.mjs            all scenes
//   node record.mjs doctor     one scene
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";

const BASE = "https://democare.tail349a3d.ts.net";
const FFMPEG =
  process.env.FFMPEG ||
  "C:/Users/ASUS/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffmpeg.exe";
const OUT = path.resolve("public/rec");
const VIEW = { width: 1600, height: 1000 };
const SCALE = 1.5; // frames are 2400x1500
const PATIENT = "Priya Sharma";
const ENQUIRY_PHONE = "9052996536"; // allowlisted: the WhatsApp is real
const WALKIN_PHONE = "6304085246"; // allowlisted second phone

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tomorrow = () => {
  const d = new Date(Date.now() + 5.5 * 3600_000 + 86400_000);
  return d.toISOString().slice(0, 10);
};

// A soft, modern cursor drawn in the page, so it is crisp in the recording.
const CURSOR = `
(() => {
  const install = () => {
    if (document.getElementById("__cur")) return;
    const s = document.createElement("style");
    s.textContent = \`
      #__cur{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;
        transition:transform 700ms cubic-bezier(.22,1,.36,1);will-change:transform;filter:drop-shadow(0 3px 6px rgba(0,0,0,.28))}
      #__cur.press svg{transform:scale(.86)} #__cur svg{transition:transform 120ms}
      .__ripple{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;pointer-events:none;z-index:2147483646;
        background:rgba(16,185,129,.35);animation:__rip 600ms ease-out forwards}
      @keyframes __rip{from{transform:scale(.2);opacity:1}to{transform:scale(1.6);opacity:0}}
      html{scrollbar-width:none} ::-webkit-scrollbar{display:none}
      aside .space-y-3 > div[class~='md:block']{display:none!important}
      input[name=phone],input[type=tel]{filter:blur(5px)}\`;
    document.head.appendChild(s);
    const c = document.createElement("div");
    c.id = "__cur";
    c.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.3-2.8 1.5-3.9-7.4L4.9 19z" fill="#0b1f17" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const p = JSON.parse(sessionStorage.getItem("__curpos") || "[800,520]");
    c.style.transition = "none";
    c.style.transform = \`translate(\${p[0]}px,\${p[1]}px)\`;
    requestAnimationFrame(() => (c.style.transition = ""));
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
  new MutationObserver(install).observe(document.documentElement, { childList: true, subtree: true });
})();`;

async function moveTo(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const b = await locator.boundingBox();
  if (!b) throw new Error("element not visible");
  const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("__cur");
    if (c) c.style.transform = `translate(${x - 5}px,${y - 3}px)`;
    sessionStorage.setItem("__curpos", JSON.stringify([x - 5, y - 3]));
  }, [x, y]);
  await sleep(750);
  return { x, y };
}

async function click(page, locator, pause = 350) {
  const { x, y } = await moveTo(page, locator);
  await page.evaluate(([x, y]) => {
    const c = document.getElementById("__cur");
    c?.classList.add("press");
    setTimeout(() => c?.classList.remove("press"), 160);
    const r = document.createElement("div");
    r.className = "__ripple";
    r.style.left = x + "px";
    r.style.top = y + "px";
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }, [x, y]);
  await locator.click();
  await sleep(pause);
}

async function type(page, locator, text, delay = 38) {
  await click(page, locator, 150);
  await locator.fill("");
  await locator.pressSequentially(text, { delay });
  await sleep(250);
}

async function select(page, locator, label) {
  await click(page, locator, 150);
  await locator.selectOption({ label });
  await sleep(300);
}

async function smoothScroll(page, y, ms = 1200) {
  await page.evaluate(([y]) => window.scrollTo({ top: y, behavior: "smooth" }), [y]);
  await sleep(ms);
}

let browser;

async function scene(name, { before, login, start, run }) {
  if (before) await sleep(before);
  const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: SCALE, locale: "en-GB", timezoneId: "Asia/Kolkata" });
  await context.addInitScript(CURSOR);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  if (login) {
    await page.goto(`${BASE}/login`);
    await page.getByRole("button", { name: login, exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  }
  await page.goto(`${BASE}${start}`);
  await page.waitForLoadState("networkidle");
  await sleep(1500); // entrance animations settle

  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", async (f) => {
    frames.push({ data: f.data, t: f.metadata.timestamp });
    try { await cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }); } catch {}
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: VIEW.width * SCALE, maxHeight: VIEW.height * SCALE, everyNthFrame: 1 });
  const t0 = Date.now() / 1000;
  await sleep(600);
  try {
    await run(page);
  } finally {
    await sleep(1200);
    await cdp.send("Page.stopScreencast").catch(() => {});
    const t1 = Date.now() / 1000;
    await context.close();
    stitch(name, frames, t0, t1);
  }
}

// Screencast frames arrive only when the page changes: each is held until the next one.
function stitch(name, frames, t0, t1) {
  const dir = path.join(OUT, `_${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lines = [];
  frames.forEach((f, i) => {
    const file = `f${String(i).padStart(5, "0")}.jpg`;
    writeFileSync(path.join(dir, file), Buffer.from(f.data, "base64"));
    const next = i + 1 < frames.length ? frames[i + 1].t : t1;
    lines.push(`file '${file}'`, `duration ${Math.max(0.001, next - f.t).toFixed(4)}`);
  });
  lines.push(`file 'f${String(frames.length - 1).padStart(5, "0")}.jpg'`);
  writeFileSync(path.join(dir, "list.txt"), lines.join("\n"));
  const out = path.join(OUT, `${name}.mp4`);
  execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", path.join(dir, "list.txt"),
    "-vf", `fps=30,scale=${VIEW.width * SCALE}:${VIEW.height * SCALE}:flags=lanczos,format=yuv420p`,
    "-c:v", "libx264", "-preset", "slow", "-crf", "14", out]);
  rmSync(dir, { recursive: true, force: true });
  console.log(`${name}: ${frames.length} frames, ${(t1 - t0).toFixed(1)}s -> ${out}`);
}

const SCENES = {
  // Patient books on the website.
  enquiry: {
    start: "/enquiry",
    run: async (page) => {
      await type(page, page.locator('input[name="full_name"]'), PATIENT);
      await type(page, page.locator('input[name="phone"]'), ENQUIRY_PHONE, 45);
      await select(page, page.locator('select[name="department"]'), "Cardiology");
      await click(page, page.locator('input[name="preferred_date"]'), 100);
      await page.locator('input[name="preferred_date"]').fill(tomorrow());
      await type(page, page.locator('textarea[name="enquiry_text"]'), "I get chest pain when I climb stairs. I would like to see a heart specialist.", 22);
      await click(page, page.getByRole("button", { name: "Request appointment" }), 300);
      await sleep(3500);
    },
  },

  // The WhatsApp messages the patient received.
  phone: {
    before: 20000, // let the worker send both WhatsApp messages
    login: "Admin",
    start: `/phone?to=${encodeURIComponent("+91" + ENQUIRY_PHONE)}`,
    run: async () => {
      await sleep(6000);
    },
  },

  // Reception registers the walk-in and gives a token.
  reception: {
    login: "Reception",
    start: "/reception/register",
    run: async (page) => {
      await type(page, page.locator('input[name="full_name"]'), PATIENT);
      await type(page, page.locator('input[name="phone"]'), WALKIN_PHONE, 45);
      await select(page, page.locator('select[name="gender"]'), "Female");
      await type(page, page.locator('input[name="age"]'), "34");
      await type(page, page.locator('input[name="allergies"]'), "Penicillin");
      await click(page, page.getByRole("button", { name: "Register patient" }), 300);
      await page.waitForURL(/\/reception\?q=/);
      await sleep(1500);
      const doctor = page.locator('select[name="doctor_id"]').first();
      await click(page, doctor, 150);
      const option = await doctor.locator("option", { hasText: "Ananya Rao" }).first().getAttribute("value");
      await doctor.selectOption(option);
      await sleep(300);
      await type(page, page.locator('input[name="reason"]').first(), "Chest pain on exertion", 30);
      await click(page, page.getByRole("button", { name: "Issue token" }).first(), 300);
      await sleep(3000);
    },
  },

  // The doctor sees her, gets warned about the allergy, prescribes and finishes.
  doctor: {
    login: "Doctor",
    start: "/consult",
    run: async (page) => {
      await sleep(1200);
      await click(page, page.getByRole("button", { name: "Call in" }).first(), 300);
      await page.waitForURL(/\/consult\/VIS/);
      await sleep(1800);
      await type(page, page.locator('textarea[name="chief_complaint"]'), "Chest pain on climbing stairs for 2 weeks", 24);
      await type(page, page.locator('textarea[name="diagnosis"]'), "Stable angina, to be evaluated", 26);
      await type(page, page.locator('textarea[name="advice"]'), "Avoid heavy exertion. Walk 20 minutes daily.", 22);
      const med = page.locator('input[name="items.0.medicine_name"]');
      await type(page, med, "Amoxicillin 500 mg", 45);
      await moveTo(page, med);
      await sleep(2600); // the allergy warning appears
      await type(page, med, "Aspirin 75 mg", 45);
      await click(page, page.getByRole("button", { name: "+ Add medicine" }), 300);
      await type(page, page.locator('input[name="items.1.medicine_name"]'), "Atorvastatin 20 mg", 45);
      await sleep(800);
      await click(page, page.getByRole("button", { name: "Finish consultation" }), 300);
      await sleep(3500);
    },
  },

  // Pharmacy dispenses and sends the bill in one click.
  pharmacy: {
    login: "Pharmacy",
    start: "/pharmacy",
    run: async (page) => {
      await sleep(1000);
      await click(page, page.getByRole("link", { name: new RegExp(PATIENT) }).first(), 300);
      await page.waitForURL(/\/pharmacy\/RX/);
      await sleep(2200);
      await click(page, page.getByRole("button", { name: "Dispense and send to billing" }), 300);
      await sleep(3500);
    },
  },

  // Billing: the bill is already built. Issue it and take the payment.
  billing: {
    login: "Billing",
    start: `/billing?view=draft&q=${encodeURIComponent(PATIENT)}`,
    run: async (page) => {
      await sleep(1000);
      await click(page, page.locator('a[href^="/billing/INV"]').first(), 300);
      await page.waitForURL(/\/billing\/INV/);
      await sleep(2200);
      await click(page, page.getByRole("button", { name: "Issue invoice" }), 300);
      await sleep(2500);
      await select(page, page.locator('select[name="method"]').first(), "UPI");
      await type(page, page.locator('input[name="reference"]').first(), "UPI 4521 8890", 40);
      await click(page, page.getByRole("button", { name: "Record payment" }).first(), 300);
      await sleep(3500);
    },
  },

  // The owner's view and the assistant.
  analytics: {
    login: "Admin",
    start: "/analytics?days=30",
    run: async (page) => {
      await sleep(1000);
      await type(page, page.getByLabel("Ask the assistant"), "How many patients did we see this month, and how much did we collect?", 28);
      await click(page, page.getByRole("button", { name: /Ask/ }).last(), 300);
      await page.locator(".pop-in").nth(1).waitFor({ timeout: 45000 });
      await sleep(4500);
      await smoothScroll(page, 700, 2500);
      await sleep(1500);
    },
  },

  // A calm overview of the dashboard, for the opening.
  dashboard: {
    login: "Admin",
    start: "/",
    run: async (page) => {
      await sleep(2500);
      await smoothScroll(page, 500, 3000);
      await sleep(1500);
    },
  },
};

const only = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
browser = await chromium.launch();
try {
  for (const [name, s] of Object.entries(SCENES)) {
    if (only.length && !only.includes(name)) continue;
    await scene(name, s);
  }
} finally {
  await browser.close();
}
