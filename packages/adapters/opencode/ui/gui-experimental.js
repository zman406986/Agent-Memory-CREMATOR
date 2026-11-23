/**
 * The desktop app's `/cremate` command (OpenCode 2.4.0).
 *
 * The server part registers the command; this part puts it in the composer's
 * slash menu and invokes it by name. OpenCode's desktop main process loads this
 * file as CommonJS, so it must not use `export` syntax.
 *
 * `Command` is the host's command registry token. The token is the public
 * `{ kind: 'registry', id: 'command' }` shape; building it here keeps this
 * part free of a runtime import from the host SDK, so it loads before the
 * desktop provides that module.
 */
const Command = Object.freeze({ kind: 'registry', id: 'command' });

const plugin = {
  setup(ctx) {
    return ctx.add(Command, () => ({
      id: 'cremate',
      title: 'Cremate memory trash',
      description: 'Remove provably useless parts of this chat now.',
      keywords: 'memory context remove prune',
      group: 'CREMATOR',
      section: 'session',
      slash: { name: 'cremate' },
      run() {
        const session = ctx.sessions.current();
        if (session === undefined) return false;
        void session.server.client.rpc.call({
          rpcID: 'cremator-opencode',
          method: 'cremate',
          input: { sessionID: session.id },
        }).catch((error) => {
          ctx.toast.show({
            title: 'CREMATOR',
            description: `Cremation failed: ${error instanceof Error ? error.message : String(error)}`,
            variant: 'error',
          });
        });
      },
    }));
  },
};

module.exports = plugin;
// The host accepts either a CommonJS module object or its `default`; expose
// both so the loader's interop does not depend on which shape it reads.
module.exports.default = plugin;
