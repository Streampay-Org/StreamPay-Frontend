# Streams grid keyboard behavior

The streams list is exposed as an ARIA `grid` when it has records. Its header
row contains column headers for recipient, rate/status, progress, and actions.
Each stream is a row with four grid cells; draft streams keep the progress cell
so column positions stay stable.

The grid uses one roving tab stop. Focus starts on the first cell and remains
inside the grid while the arrow keys move between cells. `Home` and `End` move
to the first or last column, `Ctrl+Home` and `Ctrl+End` move to the grid
corners, and `Page Up`/`Page Down` move by five rows. Horizontal movement is
reversed when the document direction is RTL. Enter and Space remain available
to native buttons and the row action menu.

The Actions menu is keyboard-operable with Enter/Space, Arrow Up/Down, and
Escape. Escape closes it and returns focus to its trigger. Loading placeholders
are announced as a status and remain outside the interactive grid.

The existing swipe-to-cancel behavior remains available on touch devices. The
action menu provides the same primary action plus an explicit cancellation
action for keyboard and pointer users. Reduced-motion users receive the same
focus and actions without menu or row transitions.
