/**
 * The card lift of the third design: a card that acts (a link, an option) rises 1 px with a
 * deeper soft shadow on hover, in 120 ms; nothing moves under reduced motion. The kit's own link
 * tiles lift the same way; this is for the pages' option cards and clickable rows.
 */
export const lift =
  'transition-[transform,box-shadow,background-color,border-color] duration-120 hover:-translate-y-px hover:shadow-[0_10px_24px_rgba(11,34,82,.10)] motion-reduce:transition-none motion-reduce:hover:translate-y-0'
