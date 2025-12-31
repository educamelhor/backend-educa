/* eslint-disable no-console */
// ============================================================================
// services/mobileNotificacoesService.js
// ============================================================================
// Módulo: MOBILE - Notificações para Pais
//
// Responsabilidade:
//  - Orquestrar o registro de notificações no banco de dados
//    relacionadas ao app mobile de responsáveis.
//  - Neste primeiro momento, NÃO envia push real. Apenas:
//      1) Grava em notificacoes_mobile
//      2) Faz console.log simulando o envio ("enviaria push...")
//
// IMPORTANTE:
//  - Este arquivo foi criado sem remover/alterar código já validado
//    em outros módulos.
//  - Integração real com Firebase / FCM será adicionada em passos futuros.
// ============================================================================

import pool from "../db.js";

// -------------------------------------------------------------
// Helpers internos
// -------------------------------------------------------------

/**
 * Converte valor para inteiro ou retorna null.
 */
function toIntOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Formata o horário para exibição na mensagem (HH:MM).
 */
function formatarHorario(horario) {
  try {
    const d = horario instanceof Date ? horario : new Date(horario);
    if (Number.isNaN(d.getTime())) return null;

    // HH:MM no padrão brasileiro
    return d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

// -------------------------------------------------------------
// Função principal: notificação de ENTRADA do aluno
// -------------------------------------------------------------

/**
 * Envia (simulado) notificações de "entrada registrada" para todos os
 * responsáveis vinculados ao aluno informado.
 *
 * ATENÇÃO:
 *  - Nesta fase, não há push real. Apenas:
 *      - INSERT em notificacoes_mobile
 *      - console.log simulando envio.
 *
 * @param {Object} params
 * @param {number} params.escolaId  - ID da escola
 * @param {number} params.alunoId   - ID do aluno
 * @param {number|null} [params.cameraId] - ID da câmera (opcional, para log)
 * @param {Date|string|null} [params.horario] - Data/hora da detecção
 */
export async function enviarNotificacoesEntradaAluno(params = {}) {
  const escolaId = toIntOrNull(params.escolaId);
  const alunoId = toIntOrNull(params.alunoId);
  const cameraId = toIntOrNull(params.cameraId) ?? null;
  const horario = params.horario ? new Date(params.horario) : new Date();

  if (!escolaId || !alunoId) {
    console.warn(
      "[mobile-notificacao] enviarNotificacoesEntradaAluno chamado sem escolaId/alunoId válidos:",
      { escolaId, alunoId }
    );
    return;
  }

  const horaStr = formatarHorario(horario) || "";

  const conn = await pool.getConnection();
  try {
    // ---------------------------------------------------------
    // 1) Buscar informações básicas do aluno (para personalizar)
    // ---------------------------------------------------------
    const [alunoRows] = await conn.query(
      `
        SELECT a.id, a.nome, a.codigo
          FROM alunos a
         WHERE a.id = ?
           AND a.escola_id = ?
         LIMIT 1
      `,
      [alunoId, escolaId]
    );

    if (!alunoRows || alunoRows.length === 0) {
      console.warn(
        "[mobile-notificacao] Aluno não encontrado para notificação de entrada:",
        { escolaId, alunoId }
      );
      conn.release();
      return;
    }

    const aluno = alunoRows[0];
    const nomeAluno = aluno.nome || "Estudante";
    const codigoAluno = aluno.codigo || null;

    // ---------------------------------------------------------
    // 2) Buscar responsáveis ativos vinculados a este aluno
    // ---------------------------------------------------------
    const [responsaveis] = await conn.query(
      `
        SELECT
          r.id,
          r.nome,
          r.email,
          r.telefone_celular
        FROM responsaveis_alunos ra
        JOIN responsaveis r
          ON r.id = ra.responsavel_id
        WHERE ra.aluno_id = ?
          AND ra.escola_id = ?
          AND ra.ativo = 1
          AND r.status = 'ATIVO'
      `,
      [alunoId, escolaId]
    );

    if (!responsaveis || responsaveis.length === 0) {
      console.log(
        "[mobile-notificacao] Nenhum responsável ativo vinculado ao aluno, nada a notificar.",
        { escolaId, alunoId }
      );
      conn.release();
      return;
    }

    // ---------------------------------------------------------
    // 3) Para cada responsável, gravar notificacao + simular push
    // ---------------------------------------------------------
    for (const resp of responsaveis) {
      const responsavelId = resp.id;

      const titulo = "Entrada registrada";
      const mensagemBase = horaStr
        ? `${nomeAluno} entrou na escola às ${horaStr}.`
        : `${nomeAluno} teve a entrada registrada na escola.`;

      const mensagem = mensagemBase;

      // Payload extra em JSON (útil para o app no futuro)
      const payload = {
        fonte: "monitoramento",
        tipo: "PRESENCA_ENTRADA",
        escola_id: escolaId,
        aluno_id: alunoId,
        aluno_codigo: codigoAluno,
        camera_id: cameraId,
        horario_iso: horario.toISOString(),
      };

      await conn.query(
        `
          INSERT INTO notificacoes_mobile
            (responsavel_id,
             aluno_id,
             escola_id,
             tipo,
             titulo,
             mensagem,
             payload_json,
             lida,
             enviada_em,
             created_at)
          VALUES
            (?, ?, ?, 'PRESENCA_ENTRADA', ?, ?, ?, 0, NULL, NOW())
        `,
        [
          responsavelId,
          alunoId,
          escolaId,
          titulo,
          mensagem,
          JSON.stringify(payload),
        ]
      );

      // Buscar devices do responsável (apenas para o log)
      const [devices] = await conn.query(
        `
          SELECT id, plataforma, device_token, ativo
            FROM mobile_devices
           WHERE responsavel_id = ?
             AND escola_id = ?
        `,
        [responsavelId, escolaId]
      );

      const ativos = (devices || []).filter((d) => d.ativo);

      console.log(
        "[mobile-notificacao] Notificação PRESENCA_ENTRADA registrada.",
        {
          escolaId,
          alunoId,
          responsavelId,
          horaStr,
          devices_total: devices?.length || 0,
          devices_ativos: ativos.length,
        }
      );

      // Simulação de push (aqui entraremos com FCM no futuro)
      if (ativos.length === 0) {
        console.log(
          "[mobile-notificacao] (simulação) Nenhum device ativo para envio de push."
        );
      } else {
        const tokensResumo = ativos.map(
          (d) => `${d.plataforma}#${String(d.device_token).slice(0, 12)}...`
        );
        console.log(
          "[mobile-notificacao] (simulação) Enviaria push para devices:",
          tokensResumo
        );
      }
    }
  } catch (err) {
    console.error(
      "[mobile-notificacao] Erro ao enviar notificações de entrada:",
      err
    );
    throw err;
  } finally {
    try {
      conn.release();
    } catch {
      // ignora
    }
  }
}

// ============================================================================
// FUTURO:
//  - Aqui adicionaremos outras funções, por exemplo:
//      - enviarNotificacoesAusenciaAluno
//      - enviarNotificacoesAdvertencia
//      - etc.
//  - E também a integração real com Firebase / FCM.
// ============================================================================
