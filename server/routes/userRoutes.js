/**
 * Registo de rotas: inativos, restauração, eliminação (soft delete).
 * Chamado a partir de server/index.js após definir handlers.
 */
function registerUserAdminRoutes(app, deps) {
  const { authMiddleware, requireActiveUser, requireRoles, handlers } = deps;
  app.get(
    '/api/usuarios/inativos',
    authMiddleware,
    requireActiveUser,
    requireRoles('admin_master', 'admin'),
    handlers.listInactiveUsers
  );
  app.put(
    '/api/usuarios/restore/:id',
    authMiddleware,
    requireActiveUser,
    requireRoles('admin_master', 'admin'),
    handlers.restoreUser
  );
  app.delete(
    '/api/usuarios/:id',
    authMiddleware,
    requireActiveUser,
    requireRoles('admin_master', 'admin'),
    handlers.deleteUserSoft
  );
}

module.exports = { registerUserAdminRoutes };
