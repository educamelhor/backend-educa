-- ============================================================================
-- Migration: create_consentimentos_log
-- Criada em: 2026-04-28
-- Propósito: Registro jurídico imutável de consentimentos LGPD
-- ATENÇÃO: Esta tabela é APPEND-ONLY. Jamais fazer UPDATE ou DELETE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS consentimentos_log (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,

  -- Identificação do vínculo
  responsavel_id  INT NOT NULL,
  aluno_id        INT NOT NULL,
  escola_id       INT NOT NULL,

  -- Snapshot da identidade no momento da assinatura (denormalizado intencionalmente)
  responsavel_nome  VARCHAR(255) NOT NULL,
  responsavel_cpf   VARCHAR(11)  NOT NULL,
  aluno_nome        VARCHAR(255) NOT NULL,

  -- Evento
  acao          ENUM('CONCEDER','REVOGAR') NOT NULL DEFAULT 'CONCEDER',
  canal         ENUM('FISICO','DIGITAL_APP','DIGITAL_WEB') NOT NULL,
  versao_termo  VARCHAR(20) NOT NULL DEFAULT '3.0',

  -- Prova de acesso (audit trail)
  ip_address  VARCHAR(45)  NULL COMMENT 'IPv4 ou IPv6 de quem assinou',
  user_agent  TEXT         NULL COMMENT 'Browser/app e versão',
  device_id   VARCHAR(255) NULL COMMENT 'Expo Push Token ou device identifier',
  plataforma  VARCHAR(50)  NULL COMMENT 'ios | android | web | fisico',

  -- Consentimento granular — art. 7º, IX, Marco Civil + Termo v3.0 cláusula 22
  chk_fotografia_cadastro    TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo captura de FOTOGRAFIA para cadastro escolar',
  chk_imagem_sistema         TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo uso de IMAGEM no sistema EDUCA.MELHOR',
  chk_template_biometrico    TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo geração de TEMPLATE BIOMÉTRICO para controle de presença',
  chk_sistemas_seguranca     TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo uso em SISTEMAS DE SEGURANÇA institucional',
  chk_app_educa_mobile       TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo instalação e uso do app EDUCA-MOBILE',
  chk_captura_educa_capture  TINYINT(1) NOT NULL DEFAULT 0
    COMMENT 'Autorizo captura via app EDUCA-CAPTURE por profissional credenciado',

  -- Canal físico: quem da escola confirmou (NULL para canal digital)
  confirmado_por_usuario_id  INT          NULL,
  confirmado_por_nome        VARCHAR(255) NULL,
  confirmado_por_ip          VARCHAR(45)  NULL,

  -- Timestamp imutável
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Índices para consulta rápida
  INDEX idx_responsavel (responsavel_id),
  INDEX idx_aluno       (aluno_id),
  INDEX idx_escola      (escola_id),
  INDEX idx_criado_em   (criado_em),
  INDEX idx_canal       (canal),
  INDEX idx_acao        (acao)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Audit log jurídico de consentimentos LGPD — IMUTÁVEL (jamais UPDATE/DELETE)';
