// Pack readable text into viewport-sized pages. `fits` measures actual rendered
// height; no text is dropped, summarized or replaced by an ellipsis.
export function paginateReceipt(messages, fits) {
  const pages = [];
  let page = [];
  for (let index = 0; index < messages.length; index += 1) {
    let rest = Array.from(messages[index]);
    let continuation = false;
    while (rest.length) {
      const item = { index, continuation, text: rest.join('') };
      if (fits([...page, item])) {
        page.push(item);
        rest = [];
      } else if (page.length) {
        pages.push(page);
        page = [];
      } else {
        let low = 1;
        let high = rest.length;
        let best = 1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          if (fits([{ ...item, text: rest.slice(0, mid).join('') }])) {
            best = mid;
            low = mid + 1;
          } else high = mid - 1;
        }
        pages.push([{ ...item, text: rest.slice(0, best).join('') }]);
        rest = rest.slice(best);
        continuation = true;
      }
    }
  }
  if (page.length) pages.push(page);
  return pages;
}
