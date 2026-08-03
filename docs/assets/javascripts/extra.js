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

// Material toggles the native "hidden" attribute on .md-top based on scroll
// position (it's a fly-in button by default). We want it permanently pinned
// under the TOC divider instead, so strip "hidden" the instant Material sets
// it and keep watching for it to come back.
function pinBackToTop(topButton) {
  topButton.removeAttribute("hidden");
  if (topButton._sfPinObserver) return; // already watching this node
  const observer = new MutationObserver(() => {
    if (topButton.hasAttribute("hidden")) topButton.removeAttribute("hidden");
  });
  observer.observe(topButton, { attributes: true, attributeFilter: ["hidden"] });
  topButton._sfPinObserver = observer;
}

function setupSidebarDividers() {
  const primaryList = document.querySelector(".md-sidebar--primary .md-nav--primary > .md-nav__list");
  const tocList = document.querySelector(".md-sidebar--secondary .md-nav--secondary > .md-nav__list");

  if (primaryList) sizeDivider(primaryList);

  if (tocList) {
    const tocDivider = sizeDivider(tocList);
    const topButton = document.querySelector(".md-top");
    if (topButton) {
      tocDivider.insertAdjacentElement("afterend", topButton);
      pinBackToTop(topButton);
    }
  }
}

document$.subscribe(setupSidebarDividers);
window.addEventListener("resize", setupSidebarDividers);
