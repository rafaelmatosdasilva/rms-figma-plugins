// ── DPR-aware border thickness ────────────────────────────────────────────────
// Figma DS specifies --thickness: 1.2px. At sub-pixel DPRs (especially 2×
// Retina), 1.2px spans a non-integer number of physical pixels and gets
// anti-aliased, making borders look thinner than designed. This snaps the value
// to the nearest physical-pixel boundary so borders render crisply at any DPR.
//
// DPR mapping:  1× → 2px (2 phys px)  1.5× → 1.33px (2 phys)
//               2× → 1.5px (3 phys, exact!)  3× → 1.67px (5 phys)
// At 2× Retina (standard Figma env): 1.5 × 2 = 3 physical px — already exact, no rounding loss.
(function () {
  var dpr = window.devicePixelRatio || 1;
  var snapped = Math.round(1.5 * dpr) / dpr;
  document.documentElement.style.setProperty('--thickness', snapped.toFixed(4) + 'px');
})();

// ── Variable type icon symbols ────────────────────────────────────────────────
// Centralised SVG <symbol> definitions for Figma variable types.
// Injected once into the document; referenced via <use href="#icon-var-TYPE">.
(function () {
  var ns  = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML =
    '<defs>' +
    '<symbol id="icon-var-COLOR" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6c.55 0 1-.45 1-1 0-.27-.1-.51-.1-.76 0-.55.45-1 1-1h1.44C12.82 11.24 14 9.74 14 8 14 4.69 11.31 2 8 2z"/>' +
      '<circle cx="5.5" cy="7.5" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="8"   cy="5.5" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="10.5" cy="7.5" r="1" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-var-FLOAT" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">' +
      '<line x1="2" y1="5.5" x2="14" y2="5.5"/>' +
      '<line x1="2" y1="10.5" x2="14" y2="10.5"/>' +
      '<line x1="6"  y1="2"   x2="5"  y2="14"/>' +
      '<line x1="11" y1="2"   x2="10" y2="14"/>' +
    '</symbol>' +
    '<symbol id="icon-var-STRING" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">' +
      '<rect x="2" y="2" width="12" height="12" rx="2.5"/>' +
      '<line x1="5.5" y1="6.5" x2="10.5" y2="6.5"/>' +
      '<line x1="8"   y1="6.5" x2="8"    y2="11"/>' +
    '</symbol>' +
    '<symbol id="icon-var-BOOLEAN" viewBox="0 0 16 16" fill="none">' +
      '<path fill-rule="evenodd" clip-rule="evenodd" d="M1.95422 7.99999C1.95446 5.47288 4.00322 3.42382 6.53039 3.42382L9.46999 3.42451C11.9972 3.42464 14.0462 5.47344 14.0462 8.00068C14.0458 10.5276 11.997 12.5753 9.46999 12.5755L6.53039 12.5762C4.00323 12.5762 1.95447 10.5271 1.95422 7.99999ZM6.53039 4.62397C4.66582 4.62397 3.15368 6.13611 3.15368 8.00068C3.15406 9.86492 4.66605 11.376 6.53039 11.376L9.46999 11.3767C11.3343 11.3766 12.8465 9.86427 12.8467 7.99999C12.8465 6.1357 11.3343 4.6234 9.46999 4.62328L6.53039 4.62397ZM4.02859 7.99999C4.02865 6.56148 5.19406 5.39598 6.63259 5.39598C8.07105 5.39607 9.23653 6.56153 9.23659 7.99999C9.23653 9.43845 8.07105 10.6039 6.63259 10.604C5.19406 10.604 4.02865 9.4385 4.02859 7.99999ZM6.63259 6.59475C5.8568 6.59475 5.22742 7.22422 5.22735 7.99999C5.22742 8.77576 5.8568 9.40384 6.63259 9.40384C7.40831 9.40376 8.03638 8.77571 8.03644 7.99999C8.03638 7.22427 7.40831 6.59483 6.63259 6.59475Z" fill="currentColor"/>' +
    '</symbol>' +
    '<symbol id="icon-component" viewBox="0 0 16 16">' +
      '<path d="M8.84734 9.167L10.0109 10.3319L10.8651 11.1861L8.03044 14.0208L7.17625 13.1666L6.01132 12.003L5.15713 11.1488L7.99315 8.31281L8.84734 9.167ZM12.0072 6.01264L13.1687 7.1755L14.0215 8.02831L11.1827 10.8671L10.3299 10.0143L9.16706 8.85281L8.31356 7.99931L11.1537 5.15914L12.0072 6.01264ZM11.1744 9.16976L12.3249 8.01933L11.1627 6.85717L10.0116 8.00829L11.1744 9.16976ZM8.01939 12.3234L9.16775 11.1751L8.0042 10.0101L6.85446 11.1599L8.01939 12.3234ZM7.68862 8L4.84846 10.8402L3.99565 9.98736L2.83279 8.82588L1.97998 7.97307L4.82084 5.13221L7.68862 8ZM10.8361 4.84012L7.98901 7.68719L5.12812 4.82631L7.9752 1.97923L10.8361 4.84012ZM4.84017 9.14283L5.9906 7.9924L4.82912 6.82954L3.67731 7.98136L4.84017 9.14283ZM7.98486 5.98986L9.13875 4.83597L7.97934 3.67657L6.82546 4.83045L7.98486 5.98986Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-variable" viewBox="0 0 16 16">' +
      '<path d="M3.15982 4.7726L7.62481 2.19414L7.99977 1.97801L8.37473 2.19414L12.8397 4.7726L13.2147 4.98873V11.0116L12.8397 11.2263L8.37473 13.8048L7.99977 14.0223L7.62481 13.8048L3.15982 11.2263L2.78555 11.0109L2.78486 4.98873L3.15982 4.7726ZM4.28539 10.1436L7.99977 12.2891L11.7148 10.1443V5.85466L8.00046 3.70917L4.2847 5.85466L4.28539 10.1436ZM6.21129 7.99946C6.21146 7.01162 7.01258 6.21029 8.00046 6.21029C8.98824 6.21041 9.78947 7.01169 9.78964 7.99946C9.78956 8.98731 8.9883 9.78851 8.00046 9.78864C7.01252 9.78864 6.21137 8.98739 6.21129 7.99946ZM8.00046 7.21018C7.56486 7.21018 7.21135 7.5639 7.21118 7.99946C7.21126 8.4351 7.56481 8.78874 8.00046 8.78874C8.43602 8.78862 8.78967 8.43502 8.78974 7.99946C8.78957 7.56398 8.43596 7.21031 8.00046 7.21018Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-focus" viewBox="0 0 16 16">' +
      '<path d="M8 1.96045C11.3353 1.96076 14.0389 4.66512 14.0391 8.00049C14.0389 11.3358 11.3353 14.0392 8 14.0396C4.66442 14.0396 1.96011 11.336 1.95996 8.00049C1.96009 4.66493 4.66441 1.96045 8 1.96045ZM8 3.46045C5.49283 3.46045 3.46009 5.49335 3.45996 8.00049C3.46011 10.5076 5.49284 12.5396 8 12.5396C10.5069 12.5392 12.5389 10.5074 12.5391 8.00049C12.5389 5.49354 10.5069 3.46076 8 3.46045ZM7.99902 4.25049C10.0701 4.25049 11.749 5.92942 11.749 8.00049C11.749 10.0715 10.0701 11.7505 7.99902 11.7505C5.92815 11.7503 4.24904 10.0714 4.24902 8.00049C4.24902 5.92955 5.92814 4.2507 7.99902 4.25049ZM7.99902 5.75049C6.75657 5.7507 5.74902 6.75798 5.74902 8.00049C5.74904 9.24298 6.75658 10.2503 7.99902 10.2505C9.24165 10.2505 10.249 9.24312 10.249 8.00049C10.249 6.75785 9.24166 5.75049 7.99902 5.75049ZM7.99902 6.81592C8.65332 6.81592 9.18457 7.34619 9.18457 8.00049C9.18452 8.65474 8.65329 9.18506 7.99902 9.18506C7.34494 9.18484 6.8145 8.65461 6.81445 8.00049C6.81445 7.34632 7.34491 6.81613 7.99902 6.81592Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-scan" viewBox="0 0 16 16" fill="none">' +
      '<path d="M13.3212 10.3791V11.7795C13.3212 12.746 12.5379 13.5293 11.5714 13.5293H10.171V12.0295H11.5714C11.7094 12.0295 11.8213 11.9176 11.8213 11.7795V10.3791H13.3212ZM14.0262 7.40085L14.0262 8.59962H1.97363V7.40085L14.0262 7.40085ZM4.1785 10.3791V11.7795C4.1785 11.9176 4.2904 12.0295 4.42848 12.0295H5.82888V13.5293H4.42848C3.46198 13.5293 2.67866 12.746 2.67866 11.7795V10.3791H4.1785ZM11.572 2.46215C12.5382 2.46246 13.3218 3.24574 13.3219 4.21197V5.61237L11.8213 5.61306V4.21266C11.8213 4.07459 11.7094 3.96269 11.5714 3.96268H10.171L10.1716 2.46215H11.572ZM2.67866 4.21266C2.67866 3.24616 3.46198 2.46285 4.42848 2.46285H5.82888V3.96268H4.42848C4.2904 3.96268 4.1785 4.07459 4.1785 4.21266V5.61306H2.67866V4.21266Z" fill="currentColor"/>' +
    '</symbol>' +
    /* ── UI chrome icons ─────────────────────────────────────────── */
    '<symbol id="icon-search" viewBox="0 0 16 16">' +
      '<path d="M9.59781 3.729C7.80046 1.93197 4.88617 1.93193 3.08884 3.729C1.29154 5.52631 1.29173 8.44054 3.08884 10.238C4.70569 11.8548 7.22558 12.0168 9.02398 10.7248L11.8503 13.5512L12.911 12.4905L10.0846 9.66414C11.3762 7.86577 11.2145 5.34569 9.59781 3.729ZM8.53715 4.78966C9.7487 6.0012 9.74854 7.96567 8.53715 9.17731C7.32553 10.3889 5.36112 10.3889 4.1495 9.17731C2.93818 7.96567 2.93798 6.00118 4.1495 4.78966C5.36104 3.57837 7.32559 3.57842 8.53715 4.78966Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-clear" viewBox="0 0 16 16">' +
      '<path d="M8.00037 1.49951C11.59 1.49973 14.5004 4.41077 14.5004 8.00049C14.5001 11.59 11.5899 14.5003 8.00037 14.5005C4.41068 14.5005 1.50063 11.5901 1.50037 8.00049C1.50037 4.41064 4.41052 1.49951 8.00037 1.49951ZM8.00037 3.00049C5.23894 3.00049 3.00037 5.23906 3.00037 8.00049C3.00063 10.7617 5.23911 13.0005 8.00037 13.0005C10.7614 13.0003 13.0001 10.7616 13.0004 8.00049C13.0004 5.2392 10.7616 3.0007 8.00037 3.00049ZM10.8451 6.21631L9.06189 7.99951L10.8451 9.78271L9.78455 10.8433L8.00134 9.06006L6.21814 10.8433L5.15759 9.78271L6.9408 7.99951L5.15759 6.21631L6.21814 5.15576L8.00134 6.93896L9.78455 5.15576L10.8451 6.21631Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-arrow-down" viewBox="0 0 16 16">' +
      '<path d="M12.7031 6.23145L8 10.9355L3.2959 6.23145L4.35645 5.1709L8 8.81445L11.6426 5.1709L12.7031 6.23145Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-arrow-right" viewBox="0 0 16 16">' +
      '<path d="M6.57519 3.29687L11.2793 8L6.5752 12.7041L5.51465 11.6436L9.1582 8L5.51465 4.35742L6.57519 3.29687Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-update" viewBox="0 0 16 16">' +
      '<path d="M11.2468 10.0142C9.88352 11.3773 7.8026 11.5832 6.2211 10.6343L6.7604 10.4872L6.36611 9.03917L3.13027 9.91891L4.0107 13.1554L5.45806 12.7618L5.18392 11.7502C7.36949 13.2363 10.3697 13.0125 12.3075 11.0749L12.8495 10.5328L11.7889 9.47213L11.2468 10.0142ZM10.5148 3.21106L10.7434 4.04868C8.56608 2.62897 5.62027 2.8744 3.70893 4.78548L3.16687 5.32755L4.22753 6.38821L4.7696 5.84614C6.21871 4.39728 8.4791 4.25468 10.0881 5.41801L9.09786 5.68731L9.49147 7.13467L12.8854 6.21143L11.9622 2.81746L10.5148 3.21106Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-copy" viewBox="0 0 16 16">' +
      '<path d="M12.8929 11.4102C12.8929 12.3767 12.1089 13.1607 11.1424 13.1607H7.34036C6.3739 13.1607 5.5906 12.3773 5.59055 11.4109V10.661H5.05884C4.09252 10.6609 3.30925 9.87743 3.30902 8.91116V3.85092C3.30916 2.88457 4.09246 2.10116 5.05884 2.10111L8.86161 2.1018C9.8281 2.1018 10.6114 2.88511 10.6114 3.85161L10.6121 4.60084L11.1431 4.60153C12.1096 4.6016 12.8929 5.38489 12.8929 6.35135L12.8929 11.4102ZM5.58986 6.35135C5.58986 5.38485 6.37386 4.60084 7.34036 4.60084H9.11227L9.11158 3.85161C9.11158 3.71354 8.99968 3.60164 8.86161 3.60164L5.05884 3.60095C4.92089 3.601 4.809 3.713 4.80886 3.85092V8.91116C4.80909 9.049 4.92095 9.16108 5.05884 9.16113H5.59055L5.58986 6.35135ZM11.1424 11.6609C11.2805 11.6609 11.3931 11.5483 11.3931 11.4102L11.3931 6.35135C11.3931 6.21332 11.2811 6.10144 11.1431 6.10137L7.34036 6.10068C7.20248 6.10068 7.09069 6.21284 7.09039 6.35066V11.4109C7.09044 11.5489 7.20232 11.6609 7.34036 11.6609L11.1424 11.6609Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-info" viewBox="0 0 12 12">' +
      '<path d="M6.00037 0.867065C8.8344 0.867507 11.132 3.16578 11.1322 5.99988C11.132 8.83391 8.83435 11.1313 6.00037 11.1317C3.166 11.1317 0.867805 8.83418 0.867554 5.99988C0.867729 3.16551 3.16596 0.867065 6.00037 0.867065ZM6.00037 2.36707C3.99438 2.36707 2.36773 3.99394 2.36755 5.99988C2.36781 8.00575 3.99443 9.63171 6.00037 9.63171C8.00593 9.63127 9.63195 8.00548 9.6322 5.99988C9.63203 3.99421 8.00597 2.36751 6.00037 2.36707ZM6.76208 8.65613H5.26208V5.13269H6.76208V8.65613ZM6.76208 4.42175H5.26208V3.24988H6.76208V4.42175Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-reset" viewBox="0 0 16 16">' +
      '<path d="M5.15234 3.61426L4.81641 4.94238L5.47559 4.4375C7.36854 2.98393 10.0812 3.34063 11.5352 5.2334C13.0017 7.14289 12.6256 9.8821 10.6982 11.3252L8.6875 12.8311L7.78809 11.6309L9.79883 10.124C11.0573 9.18175 11.3033 7.39327 10.3457 6.14648C9.39627 4.91081 7.62458 4.67783 6.38867 5.62695L5.56836 6.25586L6.93652 6.60156L6.56934 8.05664L2.72949 7.08789L3.69824 3.24707L5.15234 3.61426Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-check" viewBox="0 0 16 16">' +
      '<path d="M14.3486 4.49509L6.27734 12.5664C5.98459 12.859 5.5097 12.8588 5.2168 12.5664L1.65137 9.00095L2.71191 7.9404L5.74707 10.9756L13.2881 3.43454L14.3486 4.49509Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-warning" viewBox="0 0 14 14" fill="none">' +
      '<path d="M7 1.5L12.5 11.5H1.5L7 1.5Z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/>' +
      '<line x1="7" y1="6" x2="7" y2="8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '<circle cx="7" cy="10.2" r="0.6" fill="currentColor"/>' +
    '</symbol>' +
    '<symbol id="icon-external" viewBox="0 0 12 12" fill="none">' +
      '<path d="M5 2H2a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
      '<path d="M8 1h3v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<line x1="11" y1="1" x2="6" y2="6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>' +
    '</symbol>' +
    '<symbol id="icon-plus" viewBox="0 0 16 16">' +
      '<path d="M7.25065 7.24984V3.26269H8.75049V7.24984H12.7376V8.74968H8.75049V12.7382H7.25065V8.74968H3.26213V7.24984H7.25065Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
      '<circle cx="8.5" cy="8.5" r="1.5"/>' +
      '<path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>' +
    '</symbol>' +
    '<symbol id="icon-download" viewBox="0 0 16 16">' +
      '<path d="M8.75098 9.38867L10.5703 7.56934L11.6318 8.62988L8.79395 11.4678H12.835V12.9678H3.16602V11.4678H7.20801L4.37012 8.62988L5.43066 7.56934L7.25098 9.38965V3.0332H8.75098V9.38867Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    /* icon-tree — DS ICON Icon/Tree node 546:76268 */
    '<symbol id="icon-tree" viewBox="0 0 16 16" fill="none">' +
      '<path d="M0.872435 7.1586V7.15584C1.68521 7.15584 2.15172 7.01776 2.45238 6.86029C2.75556 6.70135 2.95708 6.49132 3.21956 6.19255C3.47072 5.90665 3.80607 5.50168 4.32303 5.20094C4.77205 4.9398 5.31537 4.77873 6.01691 4.73345C6.3107 4.01565 7.01567 3.50913 7.83923 3.50913H10.6566C11.7439 3.50914 12.626 4.39123 12.626 5.47853C12.626 6.56583 11.7439 7.44793 10.6566 7.44794H7.83923C7.02063 7.44794 6.31868 6.94767 6.02175 6.23674C5.56038 6.27688 5.27523 6.38257 5.0771 6.49776C4.80874 6.65396 4.63051 6.8595 4.34651 7.18277C4.13835 7.41972 3.8808 7.7073 3.51787 7.96308C3.87777 8.24832 4.13445 8.56673 4.34375 8.83039C4.63899 9.20232 4.82846 9.44475 5.10541 9.62657C5.29493 9.75085 5.55815 9.86468 5.97479 9.91314C6.23714 9.13416 6.97248 8.57282 7.83992 8.57282H10.6573C11.7446 8.57286 12.626 9.45424 12.626 10.5415C12.626 11.6288 11.7446 12.5102 10.6573 12.5102H7.83992C7.07161 12.5102 6.40758 12.0694 6.0832 11.4275C5.33157 11.3826 4.75405 11.19 4.2816 10.8799C3.76428 10.5402 3.4251 10.0859 3.16846 9.76261C2.89577 9.41911 2.68186 9.17215 2.36675 8.98852C2.06021 8.80999 1.59127 8.65572 0.777142 8.65568V7.15584C0.809181 7.15584 0.840926 7.15822 0.872435 7.1586ZM7.83992 10.0727C7.58104 10.0727 7.37105 10.2826 7.37105 10.5415C7.37106 10.8004 7.58105 11.0104 7.83992 11.0104H10.6573C10.9161 11.0104 11.1262 10.8004 11.1262 10.5415C11.1262 10.2827 10.9162 10.0727 10.6573 10.0727H7.83992ZM7.83923 5.01035C7.58035 5.01035 7.37105 5.21965 7.37105 5.47853C7.37106 5.73741 7.58036 5.94672 7.83923 5.94672H10.6566C10.9155 5.94671 11.1248 5.73741 11.1248 5.47853C11.1248 5.21965 10.9155 5.01036 10.6566 5.01035H7.83923Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-list" viewBox="0 0 16 16" fill="none">' +
      '<path d="M7.2918 6.3163C6.98223 6.99775 6.2971 7.47293 5.49986 7.47294L4.90117 7.47225C3.81388 7.47222 2.93246 6.59083 2.93246 5.50354C2.93246 4.41624 3.81388 3.53485 4.90117 3.53482L5.49986 3.53413C6.34519 3.53414 7.0639 4.06838 7.3429 4.81646L12.9224 4.81646L12.9224 6.3163H7.2918ZM5.49986 5.97172C5.75874 5.97171 5.96804 5.76242 5.96804 5.50354C5.96804 5.24466 5.75874 5.03536 5.49986 5.03535L4.90117 5.03466C4.64231 5.03469 4.4323 5.24467 4.4323 5.50354C4.4323 5.76241 4.64231 5.97238 4.90117 5.97241L5.49986 5.97172ZM7.28489 11.2536C6.97211 11.9267 6.29157 12.3942 5.50055 12.3944H4.90117C3.81399 12.3943 2.93253 11.5128 2.93246 10.4257C2.93246 9.33842 3.81395 8.45706 4.90117 8.45695L5.49986 8.45626C6.3511 8.45626 7.07508 8.99746 7.3498 9.75377H12.9224V11.2536H7.28489ZM5.49986 10.8938C5.75875 10.8938 5.96874 10.6839 5.96874 10.425C5.96843 10.1665 5.75899 9.95709 5.50055 9.95679H4.90117C4.64238 9.9569 4.4323 10.1668 4.4323 10.4257C4.43236 10.6844 4.64242 10.8944 4.90117 10.8945L5.49986 10.8938Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '<symbol id="icon-empty-search" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5">' +
      '<circle cx="13" cy="13" r="8"/><line x1="19" y1="19" x2="26" y2="26"/>' +
      '<line x1="9" y1="13" x2="17" y2="13"/>' +
    '</symbol>' +
    '<symbol id="icon-empty-graph" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.3">' +
      '<circle cx="8" cy="16" r="4"/><circle cx="24" cy="8" r="4"/><circle cx="24" cy="24" r="4"/>' +
      '<line x1="12" y1="14.5" x2="20" y2="9.5"/><line x1="12" y1="17.5" x2="20" y2="22.5"/>' +
    '</symbol>' +
    '<symbol id="icon-empty-list" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="14" cy="14" r="9"/>' +
      '<line x1="9" y1="14" x2="19" y2="14"/>' +
    '</symbol>' +
    /* Empty-state object icons. Exported vectors, drawn rotated -45° in the DS,
       so the rotation is baked in. Both use the DS frame (56x56) as the viewBox
       rather than each glyph's own bounding box — that preserves their relative
       sizes (the token glyph is intentionally larger than the component one) and
       clips at the frame exactly as the design does. */
    '<symbol id="icon-empty-token" viewBox="0 0 56 56" fill="currentColor" stroke="none">' +
      '<path stroke="none" transform="rotate(-45 28 28) translate(5.9302 5.9297)" d="M16.7139 0.149414L37.668 5.76367L38.2256 5.91406L38.375 6.4707L43.9912 27.4258L44.1396 27.9834L27.9834 44.1406L27.4268 43.9902L6.4707 38.376L5.91309 38.2256L5.76367 37.6689L0.149414 16.7139L0 16.1562L16.1562 0L16.7139 0.149414ZM2.23047 16.7539L7.54688 36.5928L27.3867 41.9092L41.9092 27.3857L36.5928 7.5459L16.7539 2.23047L2.23047 16.7539ZM16.9854 16.9854C19.7935 14.1775 24.3462 14.1775 27.1543 16.9854C29.962 19.7935 29.9621 24.3462 27.1543 27.1543C24.3461 29.9623 19.7925 29.9624 16.9844 27.1543C14.1766 24.3461 14.1775 19.7934 16.9854 16.9854ZM25.7402 18.3994C23.7132 16.3726 20.4265 16.3726 18.3994 18.3994C16.3726 20.4264 16.3717 23.7131 18.3984 25.7402C20.4255 27.7673 23.7131 27.7672 25.7402 25.7402C27.767 23.7132 27.7669 20.4265 25.7402 18.3994Z"/>' +
    '</symbol>' +
    '<symbol id="icon-empty-component" viewBox="0 0 56 56" fill="currentColor" stroke="none">' +
      '<path stroke="none" transform="rotate(-45 28 28) translate(12.3755 12.15235)" d="M31.249 31.6953H16.5352V16.833H31.249V31.6953ZM14.6924 31.6875H0V16.8027H14.6924V31.6875ZM18.5254 29.6855H29.2598V18.8428H18.5254V29.6855ZM1.98633 29.6748H12.7051V18.8154H1.98633V29.6748ZM14.7285 14.8711H0.0107422V0.0126953H14.7285V14.8711ZM31.2354 14.8252H16.4844V0H31.2354V14.8252ZM2.00098 12.8613H12.7383V2.02148H2.00098V12.8613ZM18.4785 12.8203H29.2412V2.00488H18.4785V12.8203Z"/>' +
    '</symbol>' +
    /* ── Node type icons ─────────────────────────────────────────── */
    '<symbol id="icon-node-text" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '<line x1="2" y1="3" x2="10" y2="3"/><line x1="6" y1="3" x2="6" y2="10"/>' +
    '</symbol>' +
    '<symbol id="icon-node-ellipse" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '<ellipse cx="6" cy="6" rx="5" ry="5"/>' +
    '</symbol>' +
    '<symbol id="icon-node-vector" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '<path d="M2 9 L5 3 L8 7 L10 5"/>' +
    '</symbol>' +
    '<symbol id="icon-node-frame" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4">' +
      '<rect x="1.5" y="1.5" width="9" height="9" rx="1.5"/>' +
    '</symbol>' +
    '<symbol id="icon-settings" viewBox="0 0 16 16">' +
      '<path d="M4.19192 4.0103L5.71662 4.04482L6.44997 2.70519L6.62329 2.39099L6.97547 2.32747C7.30735 2.26782 7.65015 2.23563 8.00091 2.23562C8.26381 2.23563 8.52199 2.25393 8.77431 2.28811L9.02497 2.32747L9.37714 2.39099L9.55047 2.70519L10.2838 4.04482L11.8085 4.0103L12.1669 4.0027L12.3989 4.27477C12.8398 4.79481 13.1901 5.3946 13.4257 6.05013L13.5473 6.38711L13.3608 6.69371L12.566 7.99951L13.3601 9.306L13.5466 9.6126L13.4251 9.94958C13.1893 10.6055 12.8384 11.2042 12.3982 11.7236L12.1669 11.9963L11.8099 11.9887L10.2838 11.9542L9.55116 13.2931L9.37852 13.608L9.02635 13.6716C8.69777 13.7306 8.35487 13.7648 8.00091 13.7648C7.64693 13.7648 7.30403 13.7301 6.97477 13.6709L6.62191 13.608L6.44928 13.2931L5.71593 11.9549L4.19123 11.988L3.83354 11.9963L3.6029 11.7229C3.16262 11.2031 2.81083 10.6047 2.57538 9.94958L2.45523 9.6126L2.64167 9.306L3.43441 7.99951L2.64098 6.69371L2.45454 6.38711L2.57607 6.05013C2.81149 5.3953 3.16178 4.79518 3.6029 4.27477L3.83423 4.00201L4.19192 4.0103ZM4.53305 5.51842C4.37244 5.74258 4.23329 5.98365 4.11804 6.23727L4.95289 7.61074L5.19043 8.0002L4.95289 8.38966L4.11804 9.76175C4.23314 10.0149 4.37247 10.2551 4.53305 10.4792L6.13923 10.4447L6.59567 10.4343L6.81457 10.8342L7.58521 12.2428C7.72301 12.2569 7.8616 12.2649 8.00091 12.2649C8.13989 12.2649 8.27822 12.2562 8.41592 12.2422L9.18725 10.8342L9.40684 10.435L9.86259 10.4447L11.4653 10.4799C11.6266 10.2554 11.767 10.0152 11.8824 9.76175L11.0489 8.38966L10.8114 8.0002L11.0489 7.61074L11.8831 6.23658C11.7676 5.98286 11.6278 5.74219 11.4667 5.51773L9.86328 5.5564L9.40684 5.56676L9.18725 5.16625L8.41523 3.75618C8.27868 3.74277 8.14028 3.73547 8.00091 3.73546C7.86087 3.73547 7.72219 3.74273 7.58521 3.75618L6.81457 5.16625L6.59498 5.56676L6.13854 5.5564L4.53305 5.51842ZM6.63503 7.85933C6.70541 7.16726 7.28962 6.62693 8.00022 6.62673L8.14109 6.63364C8.8332 6.70411 9.37369 7.28949 9.37369 8.0002C9.3735 8.75813 8.75882 9.37274 8.00091 9.37298C7.29019 9.37298 6.70482 8.8325 6.63434 8.14038L6.62744 7.99951L6.63503 7.85933ZM8.00091 7.87314C7.93071 7.87314 7.87385 7.93001 7.87385 8.0002L7.88352 8.04992C7.90295 8.09524 7.94848 8.12726 8.00091 8.12726C8.05324 8.12708 8.09898 8.09524 8.1183 8.04992L8.12797 8.0002L8.11761 7.94979C8.10478 7.91981 8.08059 7.89567 8.05063 7.88281L8.00091 7.87314Z" fill="currentColor" stroke="none"/>' +
    '</symbol>' +
    '</defs>';
  document.body.insertBefore(svg, document.body.firstChild);
})();

/**
 * Returns an <svg><use> snippet for a Figma variable resolved type.
 * @param {string} type  - 'COLOR' | 'FLOAT' | 'STRING' | 'BOOLEAN'
 * @param {number} [size=12]
 */
function varTypeIconHtml(type, size) {
  size = size || 12;
  var id = (type === 'COLOR' || type === 'FLOAT' || type === 'STRING' || type === 'BOOLEAN')
    ? '#icon-var-' + type
    : '#icon-var-FLOAT'; // fallback
  var renderSize = type === 'COLOR' ? size + 2 : type === 'STRING' ? size + 2 : size;
  return '<svg width="' + renderSize + '" height="' + renderSize + '" style="flex-shrink:0"><use href="' + id + '"/></svg>';
}

// ── Universal tooltip engine ──────────────────────────────────────────────────
(function () {
  const PAD = 10, DELAY = 2000;
  const tt = document.getElementById('tt');
  let showTimer = null, cursorX = 0, cursorY = 0, activeEl = null;

  function place() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const tw = tt.offsetWidth, th = tt.offsetHeight;
    let x = cursorX + 14, y = cursorY + 14;
    if (x + tw + PAD > vw) x = cursorX - tw - 8;
    if (y + th + PAD > vh) y = cursorY - th - 8;
    tt.style.left = x + 'px';
    tt.style.top  = y + 'px';
  }

  function show(el) {
    tt.textContent = el.dataset.tip;
    tt.classList.remove('tt-visible');
    clearTimeout(showTimer);
    showTimer = setTimeout(() => {
      place();
      tt.classList.add('tt-visible');
    }, DELAY);
  }

  function hide() {
    clearTimeout(showTimer);
    tt.classList.remove('tt-visible');
    activeEl = null;
  }

  document.addEventListener('mousemove', (e) => {
    cursorX = e.clientX;
    cursorY = e.clientY;
    if (tt.classList.contains('tt-visible')) place();
  });

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el !== activeEl) {
      activeEl = el;
      show(el);
    } else if (!el) {
      hide();
    }
  });

  document.addEventListener('mouseout', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) hide();
  });

  document.addEventListener('mousedown', hide);
  document.addEventListener('scroll',    hide, true);
  document.addEventListener('keydown',   hide, true);
})();

// ── Toast ─────────────────────────────────────────────────────────────────────
var toastTimer = null;

function showToast(msg) {
  if (toastTimer) clearTimeout(toastTimer);
  document.getElementById('toast-container').innerHTML =
    `<div class="toast"><span class="toast-icon"><svg width="16" height="16"><use href="#icon-check"/></svg></span><span>${msg}</span></div>`;
  toastTimer = setTimeout(dismissToast, 5000);
}

function dismissToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  const t = document.querySelector('.toast');
  if (!t) return;
  t.classList.add('toast-out');
  const onEnd = (ev) => {
    if (ev.animationName !== 'toast-out') return;
    t.removeEventListener('animationend', onEnd);
    document.getElementById('toast-container').innerHTML = '';
  };
  t.addEventListener('animationend', onEnd);
}

// opts: { cls: 'extra-class', cancel: fn }
function showProgress(msg, opts) {
  const cont = document.getElementById('progress-container');
  if (!cont) return;
  const cls    = (opts && opts.cls)    || '';
  const cancel = (opts && opts.cancel) || null;
  const existing = cont.querySelector('.progress-msg');
  if (existing) {
    const textEl = existing.querySelector('.progress-text');
    if (textEl) { textEl.textContent = msg; return; }
  }
  const cancelHtml = cancel
    ? `<button class="buttonTertiary" id="progress-cancel-btn"><span>Cancel</span></button>`
    : '';
  cont.innerHTML = `<div class="progress-msg${cls ? ' ' + cls : ''}"><div class="toast-content"><div class="toast-spinner"></div><span class="progress-text">${msg}</span></div>${cancelHtml}</div>`;
  if (cancel) {
    const btn = document.getElementById('progress-cancel-btn');
    if (btn) btn.addEventListener('click', cancel);
  }
}

function dismissProgress() {
  const cont = document.getElementById('progress-container');
  if (cont) cont.innerHTML = '';
}

// ── Plugin window resize (right + bottom edges) ──────────────────────────────
// opts: { edges: 'bottom'|'right'|'both', minW, maxW, minH, maxH, onSave(w,h) }
// Idempotent: calling again updates opts without adding new event listeners.
//
// Right edge uses a fixed overlay strip (8 px wide, above scrollbars, z:9990)
// so it never conflicts with a vertical scrollbar.
// Bottom uses classic edge-proximity detection.
var _winResizeOpts = null;
var _winResizeStrip = null;
function initWindowResize(opts) {
  opts = opts || {};
  if (_winResizeOpts) {
    if (opts.minW  !== undefined) _winResizeOpts.minW  = opts.minW;
    if (opts.maxW  !== undefined) _winResizeOpts.maxW  = opts.maxW;
    if (opts.minH  !== undefined) _winResizeOpts.minH  = opts.minH;
    if (opts.maxH  !== undefined) _winResizeOpts.maxH  = opts.maxH;
    if (opts.onSave !== undefined) _winResizeOpts.onSave = opts.onSave;
    if (opts.edges !== undefined) {
      _winResizeOpts.allowB = opts.edges !== 'right';
      _winResizeOpts.allowR = opts.edges !== 'bottom';
      if (_winResizeStrip) _winResizeStrip.style.display = _winResizeOpts.allowR ? '' : 'none';
    }
    return;
  }

  _winResizeOpts = {
    minW: opts.minW || 240,  maxW: opts.maxW || 1400,
    minH: opts.minH || 100,  maxH: opts.maxH || 1200,
    allowB: opts.edges !== 'right',
    allowR: opts.edges !== 'bottom',
    onSave: opts.onSave || null,
  };
  var o = _winResizeOpts;
  var THRESHOLD = 12;
  var resizing = false;

  // ── Dedicated overlay strip for right edge (avoids scrollbar conflict) ──
  _winResizeStrip = document.createElement('div');
  _winResizeStrip.style.cssText = 'position:fixed;top:0;bottom:0;right:0;width:8px;z-index:9990;cursor:ew-resize;';
  if (!o.allowR) _winResizeStrip.style.display = 'none';
  document.body.appendChild(_winResizeStrip);

  function startDrag(r, b) {
    if (resizing) return;
    resizing = true;
    window._manualResizing = true;
    var currentH = window.innerHeight, currentW = window.innerWidth;
    if (r) window._manualW = currentW;
    if (b) window._manualH = currentH;
    var cursor = b && r ? 'nwse-resize' : b ? 'ns-resize' : 'ew-resize';
    document.body.style.cursor = cursor;
    document.body.style.userSelect = 'none';
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:' + cursor + ';';
    document.body.appendChild(overlay);

    function onMove(ev) {
      if (b) { currentH = Math.min(Math.max(currentH + ev.movementY, o.minH), o.maxH); window._manualH = currentH; }
      if (r) { currentW = Math.min(Math.max(currentW + ev.movementX, o.minW), o.maxW); window._manualW = currentW; }
      parent.postMessage({ pluginMessage: { type: 'ui-resize', width: Math.round(currentW), height: Math.round(currentH) } }, '*');
    }
    function onUp() {
      resizing = false;
      window._manualResizing = false;
      overlay.remove();
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (o.onSave) o.onSave(Math.round(currentW), Math.round(currentH));
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // Right strip mousedown → horizontal resize
  _winResizeStrip.addEventListener('mousedown', function (e) {
    if (!o.allowR || e.button !== 0) return;
    e.preventDefault();
    startDrag(true, false);
  });

  // Bottom edge: classic proximity detection
  function nearB(e) { return o.allowB && window.innerHeight - e.clientY <= THRESHOLD; }

  document.addEventListener('mousemove', function (e) {
    if (resizing) return;
    var b = nearB(e);
    document.body.style.cursor = b ? 'ns-resize' : '';
  });

  document.addEventListener('mousedown', function (e) {
    if (!nearB(e)) return;
    e.preventDefault();
    startDrag(false, true);
  });
}

// Auto-initialise for every plugin: all edges, standard constraints, save-size message.
// Plugins needing custom constraints call initWindowResize() again to override.
initWindowResize({
  edges: 'both', minW: 300, maxW: 1400, minH: 160, maxH: 1200,
  onSave: function (w, h) {
    parent.postMessage({ pluginMessage: { type: 'save-size', width: w, height: h } }, '*');
  },
});

// ── Side panel resize ─────────────────────────────────────────────────────────
// Auto-detects direction from sidePanel--left / sidePanel--right class.
// opts: { min, max, defaultWidth, onDrag(w), onSave(w) }
// If onDrag is omitted, sets panel style.width directly during drag.
// Double-clicking the handle resets to defaultWidth (if provided).
function initSidePanelResize(panelEl, opts) {
  opts = opts || {};
  var handle = panelEl.querySelector('.sidePanelResize');
  if (!handle) return;
  var isRight = panelEl.classList.contains('sidePanel--right');
  var min = opts.min || 120;
  var max = opts.max || 600;
  var dragging = false, startX = 0, startW = 0;

  handle.addEventListener('dblclick', function (e) {
    if (opts.defaultWidth == null) return;
    e.preventDefault();
    var w = opts.defaultWidth;
    if (opts.onDrag) opts.onDrag(w);
    else panelEl.style.width = w + 'px';
    if (opts.onSave) opts.onSave(w);
  });
  handle.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return;
    dragging = true;
    startX = e.clientX;
    startW = panelEl.offsetWidth;
    handle.classList.add('dragging');
    panelEl.classList.add('resizing');
    e.preventDefault();
  });
  window.addEventListener('mousemove', function (e) {
    if (!dragging) return;
    var delta = isRight ? startX - e.clientX : e.clientX - startX;
    var w = Math.min(Math.max(startW + delta, min), max);
    if (opts.onDrag) opts.onDrag(w);
    else panelEl.style.width = w + 'px';
  });
  window.addEventListener('mouseup', function () {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    panelEl.classList.remove('resizing');
    if (opts.onSave) opts.onSave(panelEl.offsetWidth);
  });
}

// ── Toast overlay (shared across all plugins) ─────────────────────────────────
(function () {
  const overlay = document.createElement('div');
  overlay.id = 'toast-overlay';
  document.body.insertBefore(overlay, document.body.firstChild);

  // Overlay only activates for loading/progress — not for feedback toasts
  const overlayIds = ['progress-container'];
  const allIds     = ['toast-container', 'progress-container'];

  function hasActive() {
    return overlayIds.some(id => {
      const c = document.getElementById(id);
      return c && Array.from(c.children).some(ch =>
        !ch.classList.contains('toast-out') && !ch.classList.contains('progress-out')
      );
    });
  }

  function sync() { overlay.classList.toggle('visible', hasActive()); }

  allIds.forEach(id => {
    const c = document.getElementById(id);
    if (c) new MutationObserver(sync).observe(c, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  });
})();

// ── Segmented control helper ────────────────────────────────────────────────
/**
 * Creates a segmented control element with the given options.
 * @param {Array<{label: string, value: string, icon?: string}>} options - Control options
 * @param {string} selectedValue - Initially selected value
 * @param {Function} onChange - Callback when selection changes (receives new value)
 * @returns {HTMLElement} The segmented control container
 */
function createSegmentedControl(options, selectedValue, onChange) {
  const container = document.createElement('div');
  container.className = 'segmented-control';

  options.forEach(opt => {
    const button = document.createElement('button');
    button.className = opt.value === selectedValue ? 'selected' : '';
    button.dataset.value = opt.value;

    if (opt.icon) {
      const iconSpan = document.createElement('span');
      iconSpan.innerHTML = opt.icon;
      button.appendChild(iconSpan);
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = opt.label;
    button.appendChild(labelSpan);

    button.addEventListener('click', () => {
      if (opt.value === selectedValue) return;
      container.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
      button.classList.add('selected');
      selectedValue = opt.value;
      if (onChange) onChange(opt.value);
    });

    container.appendChild(button);
  });

  return container;
}

// ── Sliding pill for segmented controls ──────────────────────────────────────
// Positions the .seg-pill absolutely over the selected button.
// instant=true suppresses the CSS transition (used on first render and resize).
function updateSegPill(container, instant) {
  var pill = container && container.querySelector('.seg-pill');
  var sel  = container && container.querySelector('button.selected');
  if (!pill || !sel) return;
  if (instant) {
    pill.style.transition = 'none';
    pill.style.left  = sel.offsetLeft + 'px';
    pill.style.width = sel.offsetWidth + 'px';
    pill.getBoundingClientRect(); // force reflow so next transition fires cleanly
    pill.style.transition = '';
  } else {
    pill.style.left  = sel.offsetLeft + 'px';
    pill.style.width = sel.offsetWidth + 'px';
  }
}

// Initialise pills on all segmented controls present in the DOM at inject time
document.querySelectorAll('.segmented-control').forEach(function (c) {
  c.classList.add('has-pill');
  updateSegPill(c, true);
});

// Re-position pills on resize — offsetLeft/offsetWidth values are stale after layout changes
window.addEventListener('resize', function () {
  document.querySelectorAll('.segmented-control').forEach(function (c) { updateSegPill(c, true); });
});

// Re-position when a control's own size changes — critically, this fires on the
// display:none → visible transition (size 0 → real). Pills measured while a panel
// ancestor is hidden get left:0/width:0 and would otherwise stay collapsed until
// the next explicit update (first-open and search/tab-toggle bugs).
if (typeof ResizeObserver !== 'undefined') {
  var _segPillRO = new ResizeObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.target.offsetParent) updateSegPill(entry.target, true);
    });
  });
  document.querySelectorAll('.segmented-control').forEach(function (c) { _segPillRO.observe(c); });
}
