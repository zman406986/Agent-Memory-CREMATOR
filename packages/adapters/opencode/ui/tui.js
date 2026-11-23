/**
 * The terminal UI's `/cremate` slash command (OpenCode 2.4.0).
 *
 * The server part registers the command; this part puts it in the prompt's
 * slash menu and invokes it by name. OpenCode loads a package's `./tui` export
 * separately from its server part, so a server-only registration never appears
 * in the menu.
 */
export default {
  id: 'cremator-opencode-tui',
  setup(context) {
    context.keymap.layer(() => ({
      mode: 'global',
      commands: [{
        id: 'cremator-opencode.cremate',
        title: 'Cremate memory trash',
        description: 'Run one CREMATOR table pass now.',
        group: 'CREMATOR',
        palette: true,
        slash: { name: 'cremate' },
        run: async () => {
          const route = context.ui.router.current();
          if (route.type !== 'session') {
            context.ui.toast.show({ message: 'Open a session first.' });
            return;
          }
          try {
            await context.client.rpc.call({
              rpcID: 'cremator-opencode',
              method: 'cremate',
              input: { sessionID: route.sessionID },
            });
          } catch (error) {
            context.ui.toast.show({
              message: `Cremation failed: ${error instanceof Error ? error.message : String(error)}`,
              variant: 'error',
            });
          }
        },
      }],
    }));
  },
};
