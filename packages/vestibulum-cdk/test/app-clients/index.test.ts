import { describe, it, expect } from "vitest";
import { Duration } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import {
  buildAppClientOptions,
  validateFederationCallbackUrls,
  DEFAULT_ID_TOKEN_VALIDITY,
  DEFAULT_REFRESH_TOKEN_VALIDITY,
} from "../../lib/app-clients/index.js";

const DEFAULT_INPUT_BASE = {
  defaultIdTokenValidity: DEFAULT_ID_TOKEN_VALIDITY,
  defaultRefreshTokenValidity: DEFAULT_REFRESH_TOKEN_VALIDITY,
};

describe("app-clients", () => {
  describe("constants", () => {
    it("DEFAULT_ID_TOKEN_VALIDITY is 15 minutes", () => {
      expect(DEFAULT_ID_TOKEN_VALIDITY.toMinutes()).toBe(15);
    });

    it("DEFAULT_REFRESH_TOKEN_VALIDITY is 24 hours", () => {
      expect(DEFAULT_REFRESH_TOKEN_VALIDITY.toHours()).toBe(24);
    });
  });

  describe("validateFederationCallbackUrls", () => {
    it("accepts https:// URLs", () => {
      expect(() =>
        validateFederationCallbackUrls(["https://app.example.com/callback"]),
      ).not.toThrow();
    });

    it("accepts localhost http:// URLs", () => {
      expect(() =>
        validateFederationCallbackUrls([
          "http://localhost:3000/callback",
          "http://127.0.0.1:8080/callback",
        ]),
      ).not.toThrow();
    });

    it("throws for non-localhost http:// URLs", () => {
      expect(() => validateFederationCallbackUrls(["http://app.example.com/callback"])).toThrow(
        /HTTPS/,
      );
    });

    it("accepts an empty array", () => {
      expect(() => validateFederationCallbackUrls([])).not.toThrow();
    });
  });

  describe("buildAppClientOptions", () => {
    it("throws when generateSecret: true", () => {
      expect(() =>
        buildAppClientOptions({
          ...DEFAULT_INPUT_BASE,
          federationEnabled: false,
          props: { generateSecret: true },
        }),
      ).toThrow(/generateSecret/);
    });

    it("sets custom: true on authFlows", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.authFlows?.custom).toBe(true);
    });

    it("disables password auth flows", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.authFlows?.userPassword).toBe(false);
      expect(options.authFlows?.adminUserPassword).toBe(false);
      expect(options.authFlows?.userSrp).toBe(false);
    });

    it("sets generateSecret: false", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.generateSecret).toBe(false);
    });

    it("uses defaultIdTokenValidity when idTokenValidity is not provided", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.idTokenValidity?.toMinutes()).toBe(15);
    });

    it("uses per-client idTokenValidity when provided", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: { idTokenValidity: Duration.minutes(5) },
      });
      expect(options.idTokenValidity?.toMinutes()).toBe(5);
    });

    it("uses defaultRefreshTokenValidity when refreshTokenValidity is not provided", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.refreshTokenValidity?.toHours()).toBe(24);
    });

    it("sets enableTokenRevocation: true", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.enableTokenRevocation).toBe(true);
    });

    it("sets preventUserExistenceErrors: true", () => {
      const options = buildAppClientOptions({
        ...DEFAULT_INPUT_BASE,
        federationEnabled: false,
        props: {},
      });
      expect(options.preventUserExistenceErrors).toBe(true);
    });

    describe("federationEnabled: true", () => {
      it("defaults to authorizationCodeGrant flow when no oauth supplied", () => {
        const options = buildAppClientOptions({
          ...DEFAULT_INPUT_BASE,
          federationEnabled: true,
          props: {},
        });
        expect(options.oAuth?.flows?.authorizationCodeGrant).toBe(true);
      });

      it("validates HTTPS callback URLs", () => {
        expect(() =>
          buildAppClientOptions({
            ...DEFAULT_INPUT_BASE,
            federationEnabled: true,
            props: {
              oAuth: {
                flows: { authorizationCodeGrant: true },
                callbackUrls: ["http://app.example.com/callback"],
              },
            },
          }),
        ).toThrow(/HTTPS/);
      });

      it("accepts valid federation oauth props", () => {
        const options = buildAppClientOptions({
          ...DEFAULT_INPUT_BASE,
          federationEnabled: true,
          props: {
            oAuth: {
              flows: { authorizationCodeGrant: true },
              callbackUrls: ["https://app.example.com/callback"],
              scopes: [cognito.OAuthScope.OPENID],
            },
          },
        });
        expect(options.oAuth?.callbackUrls).toEqual(["https://app.example.com/callback"]);
      });
    });
  });
});
