/**
 * Crawler / agendador de produção — Diário Oficial MPMA (apps.mpma.mp.br).
 *
 * A cada 10 minutos executa o callback que:
 * - lista PDFs do diário MPMA;
 * - extrai texto, filtra Buriticupu + lista de alvos (servidores + mpmaAlvosMonitor);
 * - grava notificações na caixa e detecções em data/mpma-notificacoes-alvos.json;
 * - o dashboard consome via /api/dashboard/kpis e /api/notificacoes-monitoramento.
 *
 * Desativar: MONITOR_DIARIOS_OFF=1 no .env
 */
const cron = require('node-cron');

const CRON_MPMA = '*/10 * * * *';

/**
 * Agenda o monitor MPMA em produção.
 * @param {() => void | Promise<void>} runMpmaMonitor - ex.: runMpmaMonitor de server/index.js
 * @returns {{ scheduled: boolean, reason?: string, task?: import('node-cron').ScheduledTask, expression: string }}
 */
function scheduleMpmaProductionMonitor(runMpmaMonitor) {
  if (typeof runMpmaMonitor !== 'function') {
    console.warn('[crawlerMPMA] runMpmaMonitor inválido — cron MPMA não agendado.');
    return { scheduled: false, reason: 'invalid_callback', expression: CRON_MPMA };
  }

  if (process.env.MONITOR_DIARIOS_OFF === '1' || String(process.env.MONITOR_DIARIOS_OFF).toLowerCase() === 'true') {
    console.log('[crawlerMPMA] Monitor MPMA desligado (MONITOR_DIARIOS_OFF).');
    return { scheduled: false, reason: 'MONITOR_DIARIOS_OFF', expression: CRON_MPMA };
  }

  let inFlight = false;

  const task = cron.schedule(CRON_MPMA, () => {
    if (inFlight) {
      console.warn('[crawlerMPMA] Ciclo anterior ainda em curso — ignorando este tick (evita sobreposição).');
      return;
    }
    inFlight = true;
    console.log('[crawlerMPMA] Varredura MPMA — Buriticupu + alvos oficiais…');
    Promise.resolve(runMpmaMonitor())
      .catch((e) => console.error('[crawlerMPMA]', e && e.message ? e.message : e))
      .finally(() => {
        inFlight = false;
      });
  });

  console.log('[crawlerMPMA] Agendado em produção:', CRON_MPMA, '(timezone servidor)');
  return { scheduled: true, task, expression: CRON_MPMA };
}

module.exports = {
  CRON_MPMA,
  scheduleMpmaProductionMonitor,
};
