const draft = document.getElementById("draft")
const status = document.getElementById("status")
try { draft.value = localStorage.getItem("the-room-draft") || "" } catch { /* Storage is optional. */ }
draft.addEventListener("input", () => {
  try {
    localStorage.setItem("the-room-draft", draft.value)
    status.textContent = "Draft saved on this device."
  } catch { status.textContent = "Storage is unavailable. Keep this page open to keep your draft." }
})
window.addEventListener("online", () => { status.textContent = "You’re connected. Your draft is ready to take back to the room." })
