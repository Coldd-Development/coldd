/* Renders every approved review (window.__REVIEWS, populated by catalog.js from the real
   reviews table, approved-only) into the /reviews page's grid, newest first. Reviews from
   BuiltByBit and the Creator Store arrive on their own (see _shared/platform_reviews.ts); each
   card is app.js's window.__reviewCardHtml, the same one the homepage uses. */
(function () {
  var grid = document.getElementById('allReviewsGrid');
  if (!grid || !window.__reviewCardHtml) return;

  function render() {
    var reviews = (window.__REVIEWS || []).slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
    if (!reviews.length) { grid.innerHTML = '<p class="pd-empty">No reviews yet.</p>'; return; }
    var catalogById = {};
    (window.__CATALOG || []).forEach(function (p) { catalogById[p.id] = p; });
    grid.innerHTML = reviews.map(function (r) { return window.__reviewCardHtml(r, catalogById[r.productId]); }).join('');
    // app.js's scroll-reveal observer already ran by the time this fires (this script is chained
    // behind app.js in catalog.js's data-then), so the new .reveal cards are handed to it here or
    // they would stay at opacity 0.
    if (window.__scanReveal) window.__scanReveal(grid);
  }
  render();
})();
