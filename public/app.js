const app = document.querySelector("#app");
const modal = document.querySelector("#modal");
const logout = document.querySelector("#logout");
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const gift =
  '<div class="gift-scene" aria-hidden="true"><div class="gift-box"></div><div class="gift-lid"></div><div class="bow"></div></div>';
const money = (e) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: e.currency,
    maximumFractionDigits: 2,
  }).format(e.budget / 100);
const date = (value) =>
  new Date(String(value).slice(0, 10) + "T12:00:00").toLocaleDateString("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
let poll,
  routeVersion = 0;
const receipts = new Map();
// Invitation secrets stay in memory and the URL fragment, never persistent storage.
let invitationToken = location.pathname.startsWith("/invite")
  ? location.hash.slice(1)
  : null;
async function api(path, data, method = data === undefined ? "GET" : "POST") {
  const response = await fetch("/api" + path, {
    method,
    credentials: "same-origin",
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Secreto is temporarily unavailable. Please try again.");
  }
  if (!response.ok)
    throw new Error(body.error || "Something went wrong. Please try again.");
  return body;
}
function notify(message) {
  const box = document.querySelector("#notice");
  box.textContent = message;
  box.hidden = false;
  setTimeout(() => (box.hidden = true), 5000);
}
function dialog(title, content) {
  document.querySelector("#modal-content").innerHTML =
    `<div class="dialog-heading"><h2 id="modal-title">${escape(title)}</h2><button class="close" aria-label="Close dialog" title="Close dialog">&times;</button></div>${content}`;
  modal.querySelector(".close").onclick = () => modal.close();
  if (!modal.open) modal.showModal();
}
function errorIn(form, error) {
  let box = form.querySelector(".form-error");
  if (!box) {
    box = document.createElement("p");
    box.className = "form-error";
    box.setAttribute("role", "alert");
    form.append(box);
  }
  box.textContent = error.message;
}
async function busy(button, work) {
  button.disabled = true;
  try {
    await work();
  } catch (error) {
    notify(error.message);
  } finally {
    button.disabled = false;
  }
}
function bindForm(id, work) {
  const form = document.getElementById(id);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const button = form.querySelector("[type=submit]");
    button.disabled = true;
    form.querySelector(".form-error")?.remove();
    try {
      await work(new FormData(form));
    } catch (error) {
      errorIn(form, error);
    } finally {
      button.disabled = false;
    }
  };
}
logout.onclick = () =>
  busy(logout, async () => {
    await api("/logout", {});
    receipts.clear();
    location.href = "/";
  });
function login() {
  logout.hidden = true;
  app.innerHTML = `<section class="login">${gift}<p class="eyebrow">The joy is in the giving</p><h1>A little secret.<br>A lovely surprise.</h1><p class="muted">Bring your favorite people together.<br>Let the giving begin.</p><form class="form" id="login"><label>Organizer password<input name="password" type="password" autocomplete="current-password" required maxlength="256"></label><button type="submit">Sign in to Secreto</button></form></section>`;
  bindForm("login", async (data) => {
    await api("/login", { password: data.get("password") });
    await route();
  });
}
function eventForm(e) {
  dialog(
    e ? "Edit event" : "A new little tradition",
    `<form class="form" id="event-form"><label>Event name<input name="name" maxlength="80" placeholder="The holiday gathering" value="${escape(e?.name || "")}" required></label><label>Exchange date<input name="exchange_date" type="date" min="${new Date().toISOString().slice(0, 10)}" value="${escape(e?.exchange_date?.slice(0, 10) || "")}" required></label><div class="pair"><label>Gift budget<input name="budget" type="number" min="0" max="1000000" step="0.01" value="${e ? e.budget / 100 : 30}" required></label><label>Currency<select name="currency">${["USD", "EUR", "GBP", "KES"].map((c) => `<option ${c === e?.currency ? "selected" : ""}>${c}</option>`).join("")}</select></label></div><button type="submit">${e ? "Save changes" : "Create event"}</button></form>`,
  );
  bindForm("event-form", async (data) => {
    const body = Object.fromEntries(data);
    body.budget = Math.round(Number(body.budget) * 100);
    const result = await api(
      e ? `/events/${e.id}` : "/events",
      body,
      e ? "PATCH" : "POST",
    );
    modal.close();
    const nextHash = `#event/${e?.id || result.id}`;
    if (location.hash === nextHash) await route();
    else location.hash = nextHash;
  });
}
async function dashboard() {
  const { events } = await api("/events");
  app.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Your giving circle</p><h1>Good things, together.</h1><p class="muted">A little planning. A whole lot of joy.</p></div><button id="new-event">New event</button></div>${events.length ? `<div class="event-grid">${events.map((e) => `<a class="event-card" href="#event/${e.id}"><span class="tag ${e.drawn_at ? "drawn" : ""}">${e.drawn_at ? "Names drawn" : "Getting ready"}</span><h2>${escape(e.name)}</h2><p class="meta">${date(e.exchange_date)} &middot; ${money(e)}</p><div class="progress" role="progressbar" aria-label="Matches revealed" aria-valuenow="${e.completion}" aria-valuemin="0" aria-valuemax="100"><span style="--progress:${e.completion}%"></span></div><div class="card-bottom"><span>${e.total} participants</span><span>${e.revealed} revealed</span></div></a>`).join("")}</div>` : `<section class="empty">${gift}<h2>Every tradition starts somewhere.</h2><p class="muted">Your next favorite holiday memory is waiting.</p><button id="first-event">Create your first event</button></section>`}`;
  document.querySelector("#new-event").onclick = () => eventForm();
  document
    .querySelector("#first-event")
    ?.addEventListener("click", () => eventForm());
}
function shareText(receipt, e, reminder = false) {
  return `${reminder ? "A little reminder" : "You are invited"}, ${receipt.name}! ${e.name}: ${date(e.exchange_date)}, budget ${money(e)}. Your private invitation: ${receipt.url}\nPIN: ${receipt.pin}\nKeep your match a secret!`;
}
function showReceipts(items, e, reminder = false) {
  items.forEach((r) => receipts.set(r.id, r));
  dialog(
    items.length === 1 ? "A secret, just for them" : "Your private invitations",
    `<p class="note">Keep these details safe. Closing or refreshing this page will clear them. Creating a replacement invalidates the previous invitation.</p>${items.map((r) => `<div class="invite-receipt"><h3>${escape(r.name)}</h3><div>PIN <strong class="pin-code">${r.pin}</strong></div><a href="${escape(r.url)}" target="_blank" rel="noreferrer">${escape(r.url)}</a><a class="share" href="https://wa.me/?text=${encodeURIComponent(shareText(r, e, reminder))}" target="_blank" rel="noopener noreferrer">${reminder ? "Send reminder on WhatsApp" : "Share on WhatsApp"}</a><button class="quiet copy" data-id="${r.id}">Copy invitation</button></div>`).join("")}<div class="dialog-actions"><button id="download-invites" class="quiet">Download invitations</button><button id="done-invites">Done</button></div>`,
  );
  modal.querySelectorAll(".copy").forEach(
    (button) =>
      (button.onclick = () =>
        busy(button, async () => {
          await navigator.clipboard.writeText(
            shareText(receipts.get(button.dataset.id), e, reminder),
          );
          notify("Invitation copied.");
        })),
  );
  document.querySelector("#download-invites").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([items.map((r) => shareText(r, e)).join("\n\n")], {
        type: "text/plain",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "secreto-private-invitations.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  document.querySelector("#done-invites").onclick = () => modal.close();
}
function addParticipants(e) {
  dialog(
    "Make room for everyone",
    `<form id="participants-form" class="form"><label>Participant names<textarea name="names" placeholder="Alex&#10;Jamie&#10;Sam" required maxlength="10000"></textarea></label><p class="note">One name per line, or separated by commas. Up to 100 participants.</p><button type="submit">Add participants</button></form>`,
  );
  bindForm("participants-form", async (data) => {
    const result = await api(`/events/${e.id}/participants`, {
      names: data.get("names"),
    });
    await eventPage(e.id);
    showReceipts(result.invitations, e);
  });
}
async function eventPage(id, quiet = false) {
  const version = routeVersion;
  const { event: e, participants } = await api(`/events/${id}`);
  if (version !== routeVersion) return;
  if (quiet && (modal.open || document.activeElement?.closest(".person")))
    return;
  app.innerHTML = `<a class="breadcrumb" href="#">&larr; All events</a><div class="event-heading"><div><p class="eyebrow">${e.drawn_at ? "A little mystery is underway" : "Let the anticipation begin"}</p><h1>${escape(e.name)}</h1><div class="event-info"><span>${date(e.exchange_date)}</span><span>${money(e)} gift budget</span><span>${e.drawn_at ? "Draw complete" : "Guest list open"}</span></div></div><div class="actions">${!e.drawn_at ? '<button class="quiet" id="edit-event">Edit event</button><button id="draw-event">Draw names</button>' : ""}</div></div><div class="stats"><div class="stat"><strong>${e.total}</strong><span>Participants</span></div><div class="stat"><strong>${e.opened}</strong><span>Invitations opened</span></div><div class="stat"><strong>${e.revealed}</strong><span>Matches revealed</span></div><div class="stat"><strong>${e.pending}</strong><span>Pending invitations</span></div></div><div class="section-heading"><h2>Your people <span class="muted">(${e.total})</span></h2><span class="privacy">Mystery mode &middot; matches stay private</span>${!e.drawn_at ? '<button class="quiet" id="add-participants">Add participants</button>' : ""}</div><div>${participants.length ? participants.map((p) => `<div class="person"><div class="avatar" aria-hidden="true">${escape(p.name[0])}</div><div class="person-name">${escape(p.name)}</div><span class="status ${p.status}">${p.status}</span><div class="actions"><button class="quiet invitation-button" data-id="${p.id}">${e.drawn_at && p.status !== "Revealed" ? "Remind" : "Invitation"}</button>${!e.drawn_at ? `<button class="text-button remove-person" data-id="${p.id}">Remove</button>` : ""}</div></div>`).join("") : '<section class="empty"><h2>A gathering is better with company.</h2><p class="muted">Who is on your list?</p></section>'}</div><div class="event-progress"><div class="progress" role="progressbar" aria-label="Matches revealed" aria-valuenow="${e.completion}" aria-valuemin="0" aria-valuemax="100"><span style="--progress:${e.completion}%"></span></div><span>${e.completion}% revealed</span></div>`;
  document
    .querySelector("#edit-event")
    ?.addEventListener("click", () => eventForm(e));
  document
    .querySelector("#add-participants")
    ?.addEventListener("click", () => addParticipants(e));
  document.querySelector("#draw-event")?.addEventListener("click", () => {
    dialog(
      "Ready for a little mystery?",
      `<p>Draw names for ${e.total} participants? Once drawn, the guest list and event details are locked.</p><div class="dialog-actions"><button class="quiet" id="cancel-draw">Not yet</button><button id="confirm-draw" ${e.total < 2 ? "disabled" : ""}>Draw names</button></div>${e.total < 2 ? '<p class="note">Add at least two participants first.</p>' : ""}`,
    );
    document.querySelector("#cancel-draw").onclick = () => modal.close();
    document.querySelector("#confirm-draw").onclick = (event) =>
      busy(event.currentTarget, async () => {
        await api(`/events/${id}/draw`, {});
        modal.close();
        await eventPage(id);
        notify("Names drawn. Let the secret giving begin.");
      });
  });
  document.querySelectorAll(".remove-person").forEach(
    (button) =>
      (button.onclick = () => {
        dialog(
          "Remove participant?",
          `<p>Their invitation will stop working.</p><div class="dialog-actions"><button id="confirm-remove" class="danger">Remove participant</button></div>`,
        );
        document.querySelector("#confirm-remove").onclick = (event) =>
          busy(event.currentTarget, async () => {
            await api(
              `/events/${id}/participants/${button.dataset.id}`,
              {},
              "DELETE",
            );
            receipts.delete(button.dataset.id);
            modal.close();
            await eventPage(id);
          });
      }),
  );
  document.querySelectorAll(".invitation-button").forEach(
    (button) =>
      (button.onclick = () => {
        const pid = button.dataset.id;
        if (receipts.has(pid))
          return showReceipts([receipts.get(pid)], e, Boolean(e.drawn_at));
        dialog(
          "Create a replacement invitation?",
          `<p>The previous link and PIN will stop working. Their assigned recipient will stay the same.</p><div class="dialog-actions"><button id="replace-invite">Create replacement</button></div>`,
        );
        document.querySelector("#replace-invite").onclick = (event) =>
          busy(event.currentTarget, async () => {
            const result = await api(
              `/events/${id}/participants/${pid}/invite`,
              {},
            );
            showReceipts([result.invitation], e, Boolean(e.drawn_at));
          });
      }),
  );
}
function confetti() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const layer = document.createElement("div");
  layer.className = "confetti";
  layer.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 45; i++) {
    const bit = document.createElement("i");
    bit.style.cssText = `--x:${Math.random() * 100}%;--delay:${Math.random() * 0.5}s;--angle:${Math.random() * 360}deg;--color:${["#d5735a", "#e6bb70", "#739982"][i % 3]}`;
    layer.append(bit);
  }
  document.body.append(layer);
  setTimeout(() => layer.remove(), 4000);
}
async function participant() {
  logout.hidden = true;
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitationToken || ""))
    throw new Error(
      "This invitation is incomplete. Ask your organizer for your private link.",
    );
  const result = await api("/invite/open", { token: invitationToken });
  const e = result.event;
  const details = `<div class="reveal-detail"><div><span class="muted">Gift budget</span><strong>${money(e)}</strong></div><div><span class="muted">Exchange day</span><strong>${date(e.exchange_date)}</strong></div></div>`;
  function ready() {
    app.innerHTML = `<section class="invitation"><p class="eyebrow">${escape(e.name)}</p><h1>A little surprise,<br>just for you.</h1>${gift}<p class="muted">Someone wonderful is waiting inside.</p><button id="reveal">Unwrap my secret</button>${details}</section>`;
    document.querySelector("#reveal").onclick = (event) =>
      busy(event.currentTarget, async () => {
        const result = await api("/invite/reveal", { token: invitationToken });
        document.querySelector(".gift-scene").classList.add("open");
        const section = document.querySelector(".invitation");
        const reveal = document.createElement("div");
        reveal.innerHTML = `<p class="eyebrow">Surprise! You're the Secret Santa for</p><h2 class="recipient">${escape(result.recipient)}</h2><p>Congratulations! A thoughtful little gift<br>will make their day.</p><p class="note">Your secret is safe with us.</p>`;
        section.querySelector("h1").textContent =
          "The joy of giving starts here.";
        section.querySelector("#reveal").remove();
        section.querySelector(".gift-scene + p").remove();
        section.querySelector(".gift-scene").after(reveal);
        confetti();
      });
  }
  if (result.authorized) {
    ready();
    return;
  }
  app.innerHTML = `<section class="invitation"><p class="eyebrow">You're invited to ${escape(e.name)}</p><h1>One little PIN.<br>One lovely surprise.</h1>${gift}<form class="form" id="pin-form"><label>Your private PIN<input class="pin" name="pin" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" minlength="6" maxlength="6" required aria-label="Your six-digit PIN"></label><button type="submit">Open my invitation</button></form>${details}</section>`;
  bindForm("pin-form", async (data) => {
    await api("/invite/verify", {
      token: invitationToken,
      pin: data.get("pin"),
    });
    ready();
  });
}
async function route() {
  routeVersion++;
  clearInterval(poll);
  app.innerHTML =
    '<div class="loading" role="status">A moment of anticipation...</div>';
  try {
    if (invitationToken !== null) {
      await participant();
      return;
    }
    const session = await api("/session");
    if (session.role !== "admin") {
      login();
      return;
    }
    logout.hidden = false;
    const id = location.hash.match(/^#event\/([a-f0-9-]+)$/)?.[1];
    if (id) {
      await eventPage(id);
      poll = setInterval(() => {
        if (!document.hidden) eventPage(id, true).catch(() => {});
      }, 10000);
    } else await dashboard();
  } catch (error) {
    app.innerHTML = `<section class="empty"><h1>A little pause.</h1><p class="muted">${escape(error.message)}</p><button id="retry">Try again</button></section>`;
    document.querySelector("#retry").onclick = route;
  }
}
window.addEventListener("hashchange", () => {
  if (invitationToken !== null) invitationToken = location.hash.slice(1);
  route();
});
route();
