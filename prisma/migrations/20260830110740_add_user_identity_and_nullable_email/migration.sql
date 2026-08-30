/*
  Warnings:

  - You are about to drop the column `github_id` on the `users` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX `users_github_id_key` ON `users`;

-- AlterTable
ALTER TABLE `users` DROP COLUMN `github_id`,
    MODIFY `email` VARCHAR(255) NULL,
    MODIFY `password` VARCHAR(255) NULL;

-- CreateTable
CREATE TABLE `user_identities` (
    `id` BIGINT NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `provider_uid` VARCHAR(128) NOT NULL,
    `username` VARCHAR(100) NULL,
    `avatar_url` VARCHAR(512) NULL,
    `raw` JSON NULL,

    INDEX `user_identities_user_id_idx`(`user_id`),
    UNIQUE INDEX `user_identities_provider_provider_uid_key`(`provider`, `provider_uid`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `user_identities` ADD CONSTRAINT `user_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
