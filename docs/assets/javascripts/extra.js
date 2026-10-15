// Our own scroll-to-top FAB. Material's native `.md-top` is hidden in extra.css
// because its JS keeps repositioning it (inline `top`, `transform`, `hidden` by
// scroll direction); this button is fixed to the bottom-left corner, appears
// once the page is scrolled past a small threshold, and never moves.
const SCROLL_TOP_THRESHOLD = 200; // px

function setupScrollTopButton() {
  if (window._sfTopButton) return; // one button for the life of the page

  const button = document.createElement("button");
  button.type = "button";
  button.className = "sf-top";
  button.setAttribute("aria-label", "Scroll back to top");
  button.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M13 20h-2V8l-5.5 5.5-1.42-1.42L12 4.16l7.92 7.92-1.42 1.42L13 8z"/></svg>';
  button.addEventListener("click", () => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  });
  document.body.appendChild(button);
  window._sfTopButton = button;

  const sync = () => {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    button.classList.toggle("sf-top--show", y > SCROLL_TOP_THRESHOLD);
  };
  window.addEventListener("scroll", sync, { passive: true });
  sync();
}

document$.subscribe(() => {
  setupScrollTopButton();
});
