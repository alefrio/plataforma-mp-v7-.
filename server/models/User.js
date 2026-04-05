/**
 * Modelo lógico de utilizador (persistência em `data/users.json`, não MongoDB).
 *
 * @typedef {object} UserRecord
 * @property {string} id
 * @property {string} username
 * @property {string} nome
 * @property {string} password - hash bcrypt
 * @property {string} role - admin_master | admin | executivo | juridico | auditor | usuario | prefeito
 * @property {boolean} [ativo=true] - false = soft delete
 * @property {string} [createdAt] - ISO
 * @property {string} [desativadoEm]
 * @property {string} [desativadoPorId]
 * @property {string} [desativadoPorNome]
 * @property {string} [restauradoEm]
 * @property {string} [restauradoPorId]
 * @property {string} [restauradoPorNome]
 * @property {string} [cargo]
 * @property {string} [init]
 * @property {string} [color]
 * @property {string} [email]
 * @property {string} [phone]
 * @property {string} [whatsapp]
 */

module.exports = {};
