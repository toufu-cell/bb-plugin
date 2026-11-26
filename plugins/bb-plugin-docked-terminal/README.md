# Bottom Terminal

An experimental BB plugin that docks a terminal below the thread chat.
Click Bottom Terminal in the sidebar footer to open or hide it.
The messages and the composer move up to make room, and the right panel stays as it is.
To change its height, drag its top edge.
You can also focus that edge and press the up and down arrow keys.

Each environment gets one shell per BB browser window.
Threads in the same environment share that shell within the window.
Hiding the terminal keeps the shell running.
Opening it again shows the same shell with its recent output.
The shell starts when you open the terminal from the footer.
After a switch to an environment that has no shell yet, click Start terminal.
An environment that already has a shell attaches to it without a click.

## Limits

- The terminal appears only on thread pages.
- The New thread screen does not show the dock. Its right panel is BB's own terminal panel.
- That panel lists this same shell for its environment. Closing the shell's tab there ends the shell.
- Threads without an environment get no terminal.
- In a split layout, the terminal follows the focused pane.
- The terminal stays hidden while a dialog covers the page.
- It also stays hidden when the window is too small for it and the chat.

## Compatibility

The plugin targets BB 0.50.1 and Plugin SDK 0.6.157 only.
BB has no slot below the composer.
The plugin attaches to a thread page element found in that release.
If a later BB changes that layout, the terminal stays hidden.
After checking a new release, update the selectors in `lib/dock-host.ts`.
Update the `engines` pins at the same time.

`lib/socket.ts` adapts code from bb-plugin-floating-terminal under the MIT License. The file keeps its copyright notice.

## Local development

```sh
npm install --include=dev
bb plugin types --check
npx tsc --noEmit
bb plugin build
bb plugin install .
```

`dist/` and `node_modules/` are generated and ignored.
