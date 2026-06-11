import { afterEach, describe, expect, it } from "bun:test";
import {
    _resetSessionParentRegistryForTests,
    registerSessionParent,
    resolveRootSessionId,
    unregisterSessionParent,
} from "./session-parent-registry";

describe("session-parent-registry", () => {
    afterEach(() => {
        _resetSessionParentRegistryForTests();
    });

    it("resolves unregistered sessions to themselves", () => {
        expect(resolveRootSessionId("ses-main")).toBe("ses-main");
    });

    it("resolves a registered child to its parent", () => {
        registerSessionParent("ses-child", "ses-parent");
        expect(resolveRootSessionId("ses-child")).toBe("ses-parent");
        expect(resolveRootSessionId("ses-parent")).toBe("ses-parent");
    });

    it("walks nested children to the root", () => {
        registerSessionParent("ses-grandchild", "ses-child");
        registerSessionParent("ses-child", "ses-parent");
        expect(resolveRootSessionId("ses-grandchild")).toBe("ses-parent");
    });

    it("ignores self-parenting and empty ids", () => {
        registerSessionParent("ses-a", "ses-a");
        registerSessionParent("", "ses-parent");
        registerSessionParent("ses-b", "");
        expect(resolveRootSessionId("ses-a")).toBe("ses-a");
        expect(resolveRootSessionId("ses-b")).toBe("ses-b");
    });

    it("terminates on a registration cycle (depth cap)", () => {
        registerSessionParent("ses-x", "ses-y");
        registerSessionParent("ses-y", "ses-x");
        // Must return SOME id without looping forever.
        const resolved = resolveRootSessionId("ses-x");
        expect(resolved === "ses-x" || resolved === "ses-y").toBe(true);
    });

    it("unregister removes the linkage", () => {
        registerSessionParent("ses-child", "ses-parent");
        unregisterSessionParent("ses-child");
        expect(resolveRootSessionId("ses-child")).toBe("ses-child");
    });
});
