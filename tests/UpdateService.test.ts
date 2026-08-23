/**
 * UpdateService Tests
 *
 * Verifies version checking, caching, and update info retrieval.
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mock, type MockProxy } from "jest-mock-extended";
import { UpdateService, type UpdateInfo } from "../src/services/UpdateService";
import type { IUpdateClient } from "../src/clients/UpdateClient";

function buildUpdateInfo(override?: Partial<UpdateInfo>): UpdateInfo {
	return {
		currentVersion: "0.6.0",
		latestVersion: "99.0.0",
		updateAvailable: true,
		...override,
	};
}

describe("UpdateService", () => {
	let client: MockProxy<IUpdateClient>;

	beforeEach(() => {
		client = mock<IUpdateClient>();
	});

	test("should skip checks when in-container updates are disabled", async () => {
		const service = new UpdateService(client, { enabled: false });

		const result = await service.checkForUpdate();

		expect(result).toBeNull();
		expect(service.isEnabled).toBe(false);
		expect(client.fetchLatestVersion).not.toHaveBeenCalled();
	});

	test("should return updateAvailable true when remote version is newer", async () => {
		client.fetchLatestVersion.mockResolvedValue("99.0.0");

		const service = new UpdateService(client);
		const result = await service.checkForUpdate();

		expect(result).not.toBeNull();
		expect(result?.updateAvailable).toBe(true);
		expect(result?.latestVersion).toBe("99.0.0");
	});

	test("should return updateAvailable false when versions match", async () => {
		client.fetchLatestVersion.mockResolvedValue("0.6.0");

		const service = new UpdateService(client);
		const result = await service.checkForUpdate();

		expect(result).not.toBeNull();
		expect(result?.updateAvailable).toBe(false);
		expect(result?.latestVersion).toBe("0.6.0");
	});

	test("should return updateAvailable false when remote is older", async () => {
		client.fetchLatestVersion.mockResolvedValue("0.1.0");

		const service = new UpdateService(client);
		const result = await service.checkForUpdate();

		expect(result).not.toBeNull();
		expect(result?.updateAvailable).toBe(false);
	});

	test("should cache result and not re-fetch within cache TTL", async () => {
		client.fetchLatestVersion.mockResolvedValue("99.0.0");

		const service = new UpdateService(client);
		await service.checkForUpdate();
		await service.checkForUpdate();

		expect(client.fetchLatestVersion).toHaveBeenCalledTimes(1);
	});

	test("should handle fetch failure gracefully", async () => {
		client.fetchLatestVersion.mockResolvedValue(null);

		const service = new UpdateService(client);
		const result = await service.checkForUpdate();

		// First check with no prior cache returns null
		expect(result).toBeNull();
	});

	test("should return stale cache on fetch failure after successful check", async () => {
		client.fetchLatestVersion.mockResolvedValueOnce("99.0.0");

		const service = new UpdateService(client);
		const first = await service.checkForUpdate();

		expect(first?.updateAvailable).toBe(true);

		// Force cache expiry by accessing private field (test-only hack)
		// @ts-expect-error - accessing private for test
		service.lastCheckAt = 0;

		// Second check fails
		client.fetchLatestVersion.mockResolvedValueOnce(null);
		const second = await service.checkForUpdate();

		// Should return the stale cached result
		expect(second?.updateAvailable).toBe(true);
		expect(second?.latestVersion).toBe("99.0.0");
	});

	test("should return null from getUpdateInfo before first check", () => {
		const service = new UpdateService(client);
		const result = service.getUpdateInfo();

		expect(result).toBeNull();
	});

	test("should return cached info from getUpdateInfo after check", async () => {
		client.fetchLatestVersion.mockResolvedValue("0.7.0");

		const service = new UpdateService(client);
		await service.checkForUpdate();
		const cached = service.getUpdateInfo();

		expect(cached).not.toBeNull();
		expect(cached?.latestVersion).toBe("0.7.0");
		expect(cached?.updateAvailable).toBe(true);
	});

	test("should report isUpdating as false initially", () => {
		const service = new UpdateService(client);
		expect(service.isUpdating).toBe(false);
		expect(service.currentVersion).toBe("0.6.4");
	});
});
