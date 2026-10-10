/**
 * The Bridge's window, as one self-contained page: no fonts, scripts or
 * images from anywhere — it works with the internet down, which is exactly
 * when somebody opens it to see what is wrong.
 *
 * The script avoids template literals so this file can hold it in one.
 */
export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clinicti Bridge</title>
<style>
  :root {
    --ink: #16181c; --ink2: #4b5159; --ink3: #7a828c; --line: #e3e6eb; --canvas: #f5f6f8;
    --surface: #fff; --brand: #0b1220; --soft: #e2e7ee; --ok: #2f9e6a; --ok-soft: #e6f4ed;
    --bad: #c24a4a; --bad-soft: #f8e9e9; --warn: #c98a2b; --warn-soft: #fbf2e4;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--canvas); color: var(--ink); font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; }
  header { background: var(--brand); color: #fff; padding: 18px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: .2px; }
  header .pill { margin-inline-start: auto; font-size: 13px; padding: 4px 10px; border-radius: 999px; background: rgba(255,255,255,.12); }
  header .pill.ok::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #4ade80; margin-inline-end: 6px; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; display: grid; gap: 16px; }
  .card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 20px; box-shadow: 0 1px 2px rgba(16,24,40,.04); }
  .card h2 { margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 10px; }
  .step { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--soft); font-size: 13px; font-weight: 700; color: var(--brand); flex: none; }
  .step.done { background: var(--ok); color: #fff; }
  .sub { color: var(--ink2); margin: 0 0 14px; font-size: 14px; }
  .muted { color: var(--ink3); font-size: 13px; }
  button { font: inherit; font-weight: 600; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); padding: 9px 16px; cursor: pointer; }
  button:hover { background: var(--canvas); }
  button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
  button.primary:hover { background: #050810; }
  button.link { border: 0; background: none; padding: 4px 6px; color: var(--ink2); font-weight: 500; text-decoration: underline; }
  button:disabled { opacity: .5; cursor: default; }
  input { font: inherit; border: 1px solid var(--line); border-radius: 10px; padding: 9px 12px; background: #fff; }
  .code { font-size: 28px; letter-spacing: 6px; text-transform: uppercase; width: 230px; text-align: center; font-weight: 650; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .list { display: grid; gap: 8px; margin: 12px 0 0; padding: 0; list-style: none; }
  .list li { display: flex; align-items: center; gap: 10px; border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; }
  .list li .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .badge { font-size: 12px; font-weight: 650; border-radius: 999px; padding: 2px 9px; white-space: nowrap; }
  .badge.ok { background: var(--ok-soft); color: var(--ok); }
  .badge.bad { background: var(--bad-soft); color: var(--bad); }
  .badge.wait { background: var(--warn-soft); color: var(--warn); }
  .dest { display: grid; grid-template-columns: max-content 1fr; gap: 6px 18px; background: var(--canvas); border-radius: 12px; padding: 14px 16px; margin: 4px 0 12px; }
  .dest dt { color: var(--ink2); font-size: 14px; }
  .dest dd { margin: 0; font: 600 17px/1.4 Consolas, "Cascadia Mono", monospace; }
  .note { border-radius: 10px; padding: 10px 12px; font-size: 14px; margin: 0 0 12px; }
  .note.bad { background: var(--bad-soft); color: #7a2b2b; }
  .note.warn { background: var(--warn-soft); color: #6b4a14; }
  .note.ok { background: var(--ok-soft); color: #1f5c3f; }
  .checks { display: grid; gap: 6px; margin-top: 12px; font-size: 14px; }
  .checks div::before { content: "\\25CB"; display: inline-block; width: 22px; color: var(--ink3); }
  .checks div.yes::before { content: "\\2713"; color: var(--ok); font-weight: 700; }
  footer { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  footer .muted { margin-inline-start: auto; }
  label.toggle { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; cursor: pointer; }
  .card.wanted { border: 2px solid var(--warn); background: var(--warn-soft); }
  .card.wanted h2 { color: #6b4a14; }
  .card.wanted .list li { background: #fff; }
  .pname { font-weight: 650; font-size: 16px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header><h1>Clinicti Bridge</h1><span class="pill" id="pill">Starting…</span></header>
<main>
  <section class="card" id="pair" hidden>
    <h2><span class="step">1</span> Connect this computer to your clinic</h2>
    <p class="sub">In Clinicti, open <b>Settings → Devices</b> and press <b>Connect a machine</b>. Type the 6-letter code it shows:</p>
    <div class="note bad" id="pairNote" hidden></div>
    <form class="row" id="pairForm">
      <input class="code" id="code" maxlength="7" autocomplete="off" spellcheck="false" placeholder="ABC-123" aria-label="Pairing code">
      <button class="primary" id="pairBtn">Connect</button>
    </form>
  </section>

  <section id="connected" hidden>
    <div class="card wanted" id="waitingCard" hidden style="margin-bottom:16px">
      <h2>&#9673; A doctor is waiting</h2>
      <p class="sub">A doctor asked this machine for a result. Take it on the machine; it goes to this patient by itself.</p>
      <ul class="list" id="waiting"></ul>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2><span class="step done">&#10003;</span> <span id="who"></span></h2>
      <p class="sub" style="margin:0" id="online"></p>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2><span class="step" id="s2">2</span> Results your software saves to a folder</h2>
      <p class="sub">For x-ray sensors, cameras, ECG carts, eye scanners, ultrasounds and scanners whose software saves each picture or PDF to a folder on this computer (or the network). Choose that folder — every new file goes to Clinicti.</p>
      <ul class="list" id="folders"></ul>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="pick">Choose folder…</button>
        <button class="link" id="typePath">Type a folder path instead</button>
      </div>
      <form class="row" id="pathForm" hidden style="margin-top:10px">
        <input id="pathInput" style="flex:1;min-width:260px" placeholder="C:\\XrayImages or \\\\server\\share">
        <button>Add</button>
      </form>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2><span class="step" id="s3">3</span> Machines that send DICOM <span class="muted" style="font-weight:400">— OPG, CBCT, x-ray, ultrasound, eye OCT</span></h2>
      <p class="sub">In the machine's own software, open its DICOM settings (often called <b>DICOM node</b>, <b>PACS</b>, <b>Storage</b> or <b>Send to</b>) and add a destination with these details:</p>
      <div class="note bad" id="dicomNote" hidden></div>
      <dl class="dest">
        <dt>Address (IP)</dt><dd id="ip">—</dd>
        <dt>Port</dt><dd id="port">—</dd>
        <dt>AE title</dt><dd id="aet">—</dd>
      </dl>
      <p class="muted" style="margin:0 0 6px">If the machine has a <b>Worklist</b> setting, give it the same three details: today's patients will appear on the machine, and every picture comes back already knowing whose it is.</p>
      <div class="checks">
        <div id="cEcho">Press <b>Test</b> / <b>Verify</b> / <b>Echo</b> in the machine's software — this turns green when it reaches the Bridge</div>
        <div id="cStore">The first image arrives from the machine</div>
      </div>
      <div class="row" style="margin-top:14px">
        <button id="firewall">Allow through Windows Firewall</button>
        <label class="toggle"><input type="checkbox" id="dicomOn"> Receive DICOM</label>
        <button class="link" id="editDicom">Change port or AE title</button>
      </div>
      <form class="row" id="dicomForm" hidden style="margin-top:10px">
        <input id="portInput" style="width:110px" inputmode="numeric" aria-label="Port">
        <input id="aetInput" style="width:180px" maxlength="16" aria-label="AE title">
        <button>Save</button>
      </form>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h2>Sending to Clinicti</h2>
      <div class="note" id="queue"></div>
      <ul class="list" id="recent"></ul>
      <div id="failedBox" hidden>
        <p class="sub" style="margin:14px 0 0"><b>Clinicti did not accept these.</b> They are kept on this computer.</p>
        <ul class="list" id="failed"></ul>
        <div class="row" style="margin-top:10px"><button id="retry">Try again</button></div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <details id="adv">
        <summary style="cursor:pointer;font-weight:650">When a doctor asks for a result, also open… <span class="muted" style="font-weight:400">— optional, for whoever sets up the clinic</span></summary>
        <p class="sub" style="margin-top:12px">A command that opens the imaging software on the patient, from the vendor's own bridge instructions. It can use {patientId} (CLN-12), {fileNo}, {fullName}, {firstName}, {lastName}, {birthDate} (YYYYMMDD), {birthDateIso}, {sex} and {teeth}. Leave it empty to only show the notification.</p>
        <form class="row" id="cmdForm">
          <input id="cmdInput" style="flex:1;min-width:280px;font-family:Consolas,monospace;font-size:13px" placeholder='"C:\\Program Files\\Vendor\\Imaging.exe" -patient {patientId}' aria-label="Command">
          <button>Save</button>
        </form>
        <p class="muted" id="cmdStatus" style="margin:8px 0 0"></p>
      </details>
    </div>

    <footer>
      <button id="test">Send a test picture</button>
      <label class="toggle"><input type="checkbox" id="notifyOn"> Notify me on this computer</label>
      <label class="toggle"><input type="checkbox" id="autostart"> Start with Windows</label>
      <button class="link" id="unpair">Disconnect</button>
      <span class="muted" id="version"></span>
    </footer>
  </section>
</main>
<script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  function post(path, body) {
    return fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-bridge-ui": "1" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; }); });
  }
  function ago(t) {
    if (!t) return "";
    var s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(t).toLocaleDateString();
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  var errors = {
    code_invalid: "That code is not right, or it has expired. Make a new one in Clinicti (Settings \\u2192 Devices) and try again.",
    rate_limited: "Too many tries. Wait a few minutes, then try again.",
    key_revoked: "Clinicti disconnected this computer (the device was removed or connected somewhere else). Make a new code in Settings \\u2192 Devices to connect it again."
  };

  function render(s) {
    state = s;
    $("version").textContent = "Version " + s.version;
    $("pair").hidden = s.paired;
    $("connected").hidden = !s.paired;
    $("pill").textContent = s.paired ? (s.online === false ? "Offline — will send when back" : "Connected") : "Not connected";
    $("pill").className = "pill" + (s.paired && s.online !== false ? " ok" : "");
    if (!s.paired) {
      if (s.notice && errors[s.notice]) { $("pairNote").textContent = errors[s.notice]; $("pairNote").hidden = false; }
      return;
    }
    $("who").textContent = "Connected to " + (s.clinic ? s.clinic.name : "Clinicti") + (s.device ? " as \\u201C" + s.device.name + "\\u201D" : "");
    $("online").textContent = s.online === false ? "Cannot reach Clinicti right now. Pictures are kept here and sent as soon as the internet is back." : "This computer sends what your machines make straight into the patient's file.";

    var fl = $("folders"); fl.innerHTML = "";
    if (!s.folders.length) fl.appendChild(el("li", "muted", "No folder yet."));
    s.folders.forEach(function (f) {
      var li = el("li");
      var t = el("div", "grow"); t.appendChild(el("div", null, f.path));
      if (f.lastFile) t.appendChild(el("div", "muted", "Last picture: " + f.lastFile.name + " \\u00B7 " + ago(f.lastFile.at)));
      li.appendChild(t);
      li.appendChild(el("span", "badge " + (f.ok ? "ok" : "bad"), f.ok ? "Watching" : "Folder not found"));
      var rm = el("button", "link", "Remove"); rm.onclick = function () { post("/api/folders/remove", { path: f.path }).then(refresh); };
      li.appendChild(rm); fl.appendChild(li);
    });
    $("s2").className = "step" + (s.folders.some(function (f) { return f.ok; }) ? " done" : "");
    $("s2").innerHTML = s.folders.some(function (f) { return f.ok; }) ? "&#10003;" : "2";

    var d = s.dicom;
    $("ip").textContent = s.lan.length ? s.lan.join("  or  ") : "this computer's address";
    $("port").textContent = d.port; $("aet").textContent = d.aet;
    $("dicomOn").checked = d.enabled;
    var dn = $("dicomNote");
    if (d.enabled && d.error === "port_in_use") { dn.textContent = "Another program on this computer is already using port " + d.port + ". Change the port below, then use the new port on the machine."; dn.hidden = false; }
    else if (d.enabled && d.error) { dn.textContent = "The DICOM receiver could not start: " + d.error; dn.hidden = false; }
    else dn.hidden = true;
    $("cEcho").className = d.lastEcho ? "yes" : "";
    $("cEcho").innerHTML = d.lastEcho ? "The machine" + (d.lastEchoFrom ? " (" + d.lastEchoFrom.replace(/[<>&]/g, "") + ")" : "") + " reached the Bridge \\u00B7 " + ago(d.lastEcho) : "Press <b>Test</b> / <b>Verify</b> / <b>Echo</b> in the machine's software — this turns green when it reaches the Bridge";
    $("cStore").className = d.lastStore ? "yes" : "";
    $("cStore").textContent = d.lastStore ? "Images are arriving from the machine \\u00B7 last " + ago(d.lastStore) : "The first image arrives from the machine";
    var dicomDone = !!(d.lastEcho || d.lastStore);
    $("s3").className = "step" + (dicomDone ? " done" : ""); $("s3").innerHTML = dicomDone ? "&#10003;" : "3";

    var q = $("queue");
    if (s.queued) { q.className = "note warn"; q.textContent = s.queued + (s.queued === 1 ? " picture is" : " pictures are") + " waiting to send" + (s.lastError ? " (" + s.lastError + ")" : "") + ". They will go as soon as Clinicti can be reached."; }
    else { q.className = "note ok"; q.textContent = s.recent.length ? "Everything has been sent." : "Nothing sent yet. New pictures appear here as they go."; }
    var rl = $("recent"); rl.innerHTML = "";
    s.recent.forEach(function (r) {
      var li = el("li"); li.appendChild(el("div", "grow", r.name));
      li.appendChild(el("span", "badge " + (r.placed === "inbox" ? "wait" : "ok"), r.placed === "inbox" ? "In the imaging inbox" : "In the patient's file"));
      li.appendChild(el("span", "muted", ago(r.at))); rl.appendChild(li);
    });
    $("failedBox").hidden = !s.failedItems.length;
    var fi = $("failed"); fi.innerHTML = "";
    s.failedItems.forEach(function (f) { var li = el("li"); li.appendChild(el("div", "grow", f.name)); li.appendChild(el("span", "badge bad", f.error || "refused")); fi.appendChild(li); });
    $("autostart").checked = s.autostart;
    $("notifyOn").checked = s.notify;
    if (document.activeElement !== $("cmdInput") && !cmdDirty) $("cmdInput").value = s.onRequest || "";
    $("cmdStatus").textContent = s.lastCommand ? (s.lastCommand.ok ? "Last run " + ago(s.lastCommand.at) + "." : "Last run failed: " + (s.lastCommand.error || "")) : "";

    var wl = $("waiting"); wl.innerHTML = "";
    $("waitingCard").hidden = !(s.waiting && s.waiting.length);
    (s.waiting || []).forEach(function (r) {
      var p = r.patient;
      var pid = p.fileNo != null ? "CLN-" + p.fileNo : "";
      var li = el("li"); li.setAttribute("data-waiting", r.id);
      var g = el("div", "grow");
      g.appendChild(el("div", "pname", p.name));
      var what = r.kind === "xray" ? "X-ray" : r.kind === "photo" ? "Photo" : "Result";
      g.appendChild(el("div", "muted", [what + (r.note ? ": " + r.note : ""), pid, p.birthDate, r.teeth.length ? "Tooth " + r.teeth.join(" ") : "", r.requestedBy ? "asked by " + r.requestedBy : "", ago(Date.parse(r.createdAt))].filter(Boolean).join(" \\u00B7 ")));
      li.appendChild(g);
      var c1 = el("button", null, "Copy name"); c1.onclick = function () { copy(p.name, c1); }; li.appendChild(c1);
      if (pid) { var c2 = el("button", null, "Copy " + pid); c2.onclick = function () { copy(pid, c2); }; li.appendChild(c2); }
      wl.appendChild(li);
    });
  }
  var cmdDirty = false;
  function copy(text, b) {
    var label = b.textContent;
    navigator.clipboard.writeText(text).then(function () { b.textContent = "Copied \\u2713"; setTimeout(function () { b.textContent = label; }, 1500); });
  }

  function refresh() { return fetch("/api/state").then(function (r) { return r.json(); }).then(render).catch(function () { $("pill").textContent = "The Bridge is not running"; }); }

  $("pairForm").onsubmit = function (e) {
    e.preventDefault();
    var code = $("code").value.replace(/[^a-z0-9]/gi, "");
    if (code.length !== 6) { $("pairNote").textContent = "The code has 6 letters and numbers."; $("pairNote").hidden = false; return; }
    $("pairBtn").disabled = true; $("pairBtn").textContent = "Connecting…";
    post("/api/pair", { code: code }).then(function (r) {
      $("pairBtn").disabled = false; $("pairBtn").textContent = "Connect";
      if (r.ok) { $("pairNote").hidden = true; refresh(); }
      else { $("pairNote").textContent = errors[r.error] || "Could not reach Clinicti. Check this computer's internet connection and try again."; $("pairNote").hidden = false; }
    });
  };
  $("code").oninput = function () { var v = this.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); this.value = v.length > 3 ? v.slice(0, 3) + "-" + v.slice(3) : v; };
  $("pick").onclick = function () {
    var b = this; b.disabled = true; b.textContent = "Choose in the window that opened…";
    post("/api/folders/pick").then(function (r) { b.disabled = false; b.textContent = "Choose folder…"; if (r.ok === false && !r.cancelled) alert("That folder cannot be found."); refresh(); });
  };
  $("typePath").onclick = function () { $("pathForm").hidden = false; $("pathInput").focus(); };
  $("pathForm").onsubmit = function (e) { e.preventDefault(); post("/api/folders/add", { path: $("pathInput").value }).then(function (r) { if (!r.ok) alert("That folder cannot be found on this computer."); else { $("pathInput").value = ""; $("pathForm").hidden = true; } refresh(); }); };
  $("dicomOn").onchange = function () { post("/api/dicom", { enabled: this.checked }).then(refresh); };
  $("editDicom").onclick = function () { $("dicomForm").hidden = false; $("portInput").value = state.dicom.port; $("aetInput").value = state.dicom.aet; };
  $("dicomForm").onsubmit = function (e) { e.preventDefault(); post("/api/dicom", { port: $("portInput").value, aet: $("aetInput").value }).then(function () { $("dicomForm").hidden = true; refresh(); }); };
  $("firewall").onclick = function () { var b = this; b.disabled = true; post("/api/firewall").then(function (r) { b.disabled = false; b.textContent = r.ok ? "Allowed \\u2713" : "Not allowed — try again"; }); };
  $("test").onclick = function () { var b = this; post("/api/test").then(function () { b.textContent = "Test sent \\u2713 — look in Clinicti's Imaging page"; refresh(); }); };
  $("retry").onclick = function () { post("/api/retry").then(refresh); };
  $("autostart").onchange = function () { post("/api/autostart", { on: this.checked }).then(refresh); };
  $("notifyOn").onchange = function () { post("/api/notify", { on: this.checked }).then(refresh); };
  $("cmdInput").oninput = function () { cmdDirty = true; };
  $("cmdForm").onsubmit = function (e) { e.preventDefault(); post("/api/on-request", { command: $("cmdInput").value }).then(function () { cmdDirty = false; $("cmdStatus").textContent = "Saved."; refresh(); }); };
  $("unpair").onclick = function () { if (confirm("Disconnect this computer from Clinicti? Machines will stop sending until you connect it again.")) post("/api/unpair").then(refresh); };

  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;
