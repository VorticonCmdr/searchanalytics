// Follows the OS colour scheme. Loaded as a classic script in <head> (not bundled)
// so the theme is set before first paint and pages never flash light-then-dark.
(() => {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    document.documentElement.dataset.bsTheme = query.matches ? "dark" : "light";
  };
  apply();
  query.addEventListener("change", apply);
})();
