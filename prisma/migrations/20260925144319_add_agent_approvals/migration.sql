-- CreateTable
CREATE TABLE `agent_approvals` (
    `id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `thread_id` VARCHAR(64) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `prompt` VARCHAR(1000) NOT NULL,
    `action_type` VARCHAR(64) NOT NULL DEFAULT 'create_post_draft',
    `payload` JSON NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `decided_at` DATETIME(3) NULL,
    `reason` VARCHAR(500) NULL,
    `executed_at` DATETIME(3) NULL,
    `result` JSON NULL,
    `error` TEXT NULL,

    UNIQUE INDEX `agent_approvals_thread_id_key`(`thread_id`),
    INDEX `agent_approvals_user_id_status_idx`(`user_id`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
