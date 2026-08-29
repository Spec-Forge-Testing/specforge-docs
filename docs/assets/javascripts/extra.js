function widestVisibleLinkWidth(navList) {
  // Links are full-width blocks, so their own rect doesn't reflect the text
  // length. Measure the .md-ellipsis span's natural (untruncated) text width
  // via scrollWidth instead, so the divider hugs the actual label, not the
  // link's click target.
  const origin = navList.getBoundingClientRect().left;
  let widest = 0;
  navList.querySelectorAll(".md-nav__link").forEach((link) => {
    const linkRect = link.getBoundingClientRect();
    if (linkRect.width === 0) return; // collapsed/hidden section, not rendered
    const label = link.querySelector(".md-ellipsis") || link;
    const labelLeft = label.getBoundingClientRect().left;
    const right = labelLeft - origin + label.scrollWidth;
    if (right > widest) widest = right;
  });
  return widest;
}

function ensureDivider(navList) {
  let divider = navList.nextElementSibling;
  if (!divider || !divider.classList.contains("sf-nav-divider")) {
    divider = document.createElement("div");
    divider.className = "sf-nav-divider";
    navList.insertAdjacentElement("afterend", divider);
  }
  return divider;
}

function sizeDivider(navList) {
  const divider = ensureDivider(navList);
  const width = widestVisibleLinkWidth(navList);
  if (width > 0) {
    divider.style.setProperty("--sf-divider-width", `${Math.ceil(width)}px`);
  }
  return divider;
}

function setupSidebarDividers() {
  const primaryList = document.querySelector(".md-sidebar--primary .md-nav--primary > .md-nav__list");
  const tocList = document.querySelector(".md-sidebar--secondary .md-nav--secondary > .md-nav__list");

  if (primaryList) sizeDivider(primaryList);
  if (tocList) sizeDivider(tocList);
}

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
    window.scrollTo({ top: 0, behavior: "smooth" });
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
  setupSidebarDividers();
  setupScrollTopButton();
});
window.addEventListener("resize", setupSidebarDividers);
