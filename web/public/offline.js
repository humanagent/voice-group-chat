const draft = document.getElementById("draft")
const status = document.getElementById("status")
try { draft.value = localStorage.getItem("the-room-draft") || "" } catch { /* Storage is optional. */ }
draft.addEventListener("input", () => {
  try {
    localStorage.setItem("the-room-draft", draft.value)
    status.textContent = "Draft saved on this device."
  } catch { status.textContent = "Storage is unavailable. Keep this page open to keep your draft." }
})
// Match the live composer: accept input only after restoring/binding the draft.
// Storage failures must not keep the offline editor disabled.
draft.placeholder = "Type a message…"
draft.disabled = false
window.addEventListener("online", () => { status.textContent = "You’re connected. Your draft is ready to take back to the room." })
