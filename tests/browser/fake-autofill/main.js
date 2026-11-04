// Page-world part of a fake autofill tool: drives react-select through its API.
window.addEventListener("message", (event) => {
  if (event.data !== "fake-autofill-go") return;
  (function fakeFillDropdowns() {
    for (const input of document.querySelectorAll('input[role="combobox"]')) {
      const key = Object.keys(input).find((k) => k.startsWith("__reactFiber$"));
      let fiber = key && input[key];
      for (let i = 0; fiber && i < 60; i++, fiber = fiber.return)
        if (typeof fiber.stateNode?.selectOption === "function") {
          const instance = fiber.stateNode;
          if (instance.props.options.length) instance.selectOption(instance.props.options[0]);
          break;
        }
    }
  })();
});
