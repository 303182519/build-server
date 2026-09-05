-- CreateTable
CREATE TABLE `job_runs` (
    `id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `deleted_at` DATETIME(3) NULL,
    `name` VARCHAR(128) NOT NULL,
    `queue_name` VARCHAR(64) NOT NULL DEFAULT 'default',
    `bull_job_id` VARCHAR(128) NULL,
    `trigger_type` VARCHAR(32) NOT NULL DEFAULT 'manual',
    `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `payload` JSON NULL,
    `result` JSON NULL,
    `error_message` TEXT NULL,
    `attempts_made` INTEGER NOT NULL DEFAULT 0,
    `max_attempts` INTEGER NOT NULL DEFAULT 1,
    `started_at` DATETIME(3) NULL,
    `finished_at` DATETIME(3) NULL,
    `created_by` BIGINT NULL,

    INDEX `job_runs_status_created_at_idx`(`status`, `created_at`),
    INDEX `job_runs_name_created_at_idx`(`name`, `created_at`),
    INDEX `job_runs_bull_job_id_idx`(`bull_job_id`),
    INDEX `job_runs_deleted_at_idx`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
