/**
 * Handlers de ciclo de vida de utilizadores (soft delete / restauração).
 * Recebe dependências do index (array users em memória + persistência).
 */
const { appendUserAuditLog } = require('../services/userAuditLog');

function isUserActive(u) {
  return u && u.ativo !== false;
}

function isProtectedAdminRole(role) {
  return role === 'admin_master' || role === 'admin';
}

/**
 * @param {object} opts
 * @param {() => any[]} opts.getUsers
 * @param {() => void} opts.persistUsers
 * @param {(u: object) => object} opts.userRowForAdmin
 */
function createUserLifecycleHandlers(opts) {
  const { getUsers, persistUsers, userRowForAdmin } = opts;

  function canActorDeactivateTarget(actorRole, target) {
    if (!target) return false;
    if (target.role === 'admin_master') return false;
    if (target.role === 'admin') return actorRole === 'admin_master';
    return actorRole === 'admin_master' || actorRole === 'admin';
  }

  function canActorRestoreTarget(actorRole, target) {
    if (!target) return false;
    if (target.role === 'admin_master' || target.role === 'admin') return actorRole === 'admin_master';
    return actorRole === 'admin_master' || actorRole === 'admin';
  }

  function validateUserIdParam(id) {
    const s = String(id || '').trim();
    if (!s || s.length > 64 || !/^u[a-zA-Z0-9_-]+$/.test(s)) return null;
    return s;
  }

  function listInactiveUsers(req, res) {
    try {
      const users = getUsers();
      let list = users.filter((u) => u.ativo === false);
      if (req.user.role === 'admin') {
        list = list.filter((u) => !isProtectedAdminRole(u.role));
      }
      res.json(list.map((u) => userRowForAdmin(u)));
    } catch (e) {
      console.error('[users] listInactive:', e.message);
      res.status(500).json({ error: 'Erro ao listar utilizadores inativos' });
    }
  }

  function deleteUserSoft(req, res) {
    try {
      const id = validateUserIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      if (req.user.sub === id) {
        return res.status(400).json({ error: 'Não pode desativar a sua própria conta' });
      }

      const users = getUsers();
      const target = users.find((x) => x.id === id);
      if (!target) return res.status(404).json({ error: 'Utilizador não encontrado' });

      if (!isUserActive(target)) {
        return res.status(400).json({ error: 'Utilizador já está inativo' });
      }

      if (!canActorDeactivateTarget(req.user.role, target)) {
        return res.status(403).json({ error: 'Não é permitido desativar este perfil' });
      }

      target.ativo = false;
      target.desativadoEm = new Date().toISOString();
      target.desativadoPorId = req.user.sub;
      target.desativadoPorNome = req.user.nome || req.user.username || '';

      persistUsers();

      appendUserAuditLog({
        acao: 'SOFT_DELETE',
        adminId: req.user.sub,
        adminEmail: req.user.username,
        alvoId: target.id,
        alvoUsername: target.username,
        alvoNome: target.nome,
        alvoRole: target.role,
      });
      console.log(
        `[users] Desativado: ${target.username} (${target.id}) por ${req.user.username || req.user.sub} (${req.user.sub})`
      );

      res.json({ message: 'Utilizador desativado com sucesso', user: userRowForAdmin(target) });
    } catch (e) {
      console.error('[users] deleteUserSoft:', e.message);
      res.status(500).json({ error: 'Erro ao desativar utilizador' });
    }
  }

  function restoreUser(req, res) {
    try {
      const id = validateUserIdParam(req.params.id);
      if (!id) return res.status(400).json({ error: 'ID inválido' });

      const users = getUsers();
      const target = users.find((x) => x.id === id);
      if (!target) return res.status(404).json({ error: 'Utilizador não encontrado' });

      if (isUserActive(target)) {
        return res.status(400).json({ error: 'Utilizador já está ativo' });
      }

      if (!canActorRestoreTarget(req.user.role, target)) {
        return res.status(403).json({ error: 'Não é permitido restaurar este perfil' });
      }

      const uname = String(target.username || '').trim().toLowerCase();
      const dup = users.some((x) => x.id !== target.id && isUserActive(x) && String(x.username || '').trim().toLowerCase() === uname);
      if (dup) {
        return res.status(409).json({ error: 'Já existe outro utilizador ativo com o mesmo username' });
      }

      target.ativo = true;
      target.restauradoEm = new Date().toISOString();
      target.restauradoPorId = req.user.sub;
      target.restauradoPorNome = req.user.nome || req.user.username || '';
      delete target.desativadoEm;
      delete target.desativadoPorId;
      delete target.desativadoPorNome;

      persistUsers();

      appendUserAuditLog({
        acao: 'RESTORE',
        adminId: req.user.sub,
        adminEmail: req.user.username,
        alvoId: target.id,
        alvoUsername: target.username,
        alvoNome: target.nome,
        alvoRole: target.role,
      });
      console.log(
        `[users] Restaurado: ${target.username} (${target.id}) por ${req.user.username || req.user.sub} (${req.user.sub})`
      );

      res.json({ message: 'Utilizador restaurado com sucesso', user: userRowForAdmin(target) });
    } catch (e) {
      console.error('[users] restoreUser:', e.message);
      res.status(500).json({ error: 'Erro ao restaurar utilizador' });
    }
  }

  return {
    listInactiveUsers,
    deleteUserSoft,
    restoreUser,
    isUserActive,
  };
}

module.exports = {
  createUserLifecycleHandlers,
  isUserActive,
};
