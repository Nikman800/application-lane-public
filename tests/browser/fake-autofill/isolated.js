// Isolated-world part: sets a value directly, with no events at all.
window.addEventListener("message", (event) => {
  if (event.data !== "fake-autofill-go") return;
  document.querySelector('[name="email"]').value = "direct@example.test";
});
