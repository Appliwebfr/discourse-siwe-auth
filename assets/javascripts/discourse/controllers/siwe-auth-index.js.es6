import Controller from "@ember/controller";
import I18n from "I18n";
import { withPluginApi } from "discourse/lib/plugin-api";
import Web3Modal from "../lib/web3modal";

export default Controller.extend({
  init() {
    this._super(...arguments);
    this.setupProvider();
  },

  userCanceled(error) {
    if (!error) {
      return false;
    }

    if (error.canceled) {
      return true;
    }

    if (error.code === 4001) {
      return true;
    }

    const message = error.message || "";
    return /user rejected/i.test(message);
  },

  verifySignature(account, message, signature, avatar) {
    document.getElementById("eth_account").value = account;
    document.getElementById("eth_message").value = message;
    document.getElementById("eth_signature").value = signature;
    document.getElementById("eth_avatar").value = avatar;
    document.getElementById("siwe-sign").submit();
  },

  async setupProvider() {
    const env =
      withPluginApi("0.11.7", (api) => {
        const siteSettings = api.container.lookup("site-settings:main");

        return {
          PROJECT_ID: siteSettings.siwe_project_id,
        };
      }) || {};

    const provider = Web3Modal.create();
    this.setProperties({ provider, providerReady: provider.providerInit(env) });

    try {
      await this.providerReady;
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Failed to initialise SIWE provider", e);
      this.set(
        "connectionError",
        I18n.t("eth_providers.errors.initialization_failed")
      );
      this.setProperties({ provider: null, providerReady: null });
      throw e;
    }
  },

  async ensureProvider() {
    try {
      if (!this.provider) {
        await this.setupProvider();
      } else if (this.providerReady) {
        await this.providerReady;
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("Unable to prepare SIWE provider", e);
      this.set(
        "connectionError",
        I18n.t("eth_providers.errors.initialization_failed")
      );
      return null;
    }

    return this.provider;
  },

  actions: {
    async connectInjected() {
      const provider = await this.ensureProvider();
      if (!provider) {
        return;
      }

      this.setProperties({ isConnecting: true, connectionError: null });

      try {
        const [account, message, signature, avatar] = await provider.signWithInjected();
        this.verifySignature(account, message, signature, avatar);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        if (!this.userCanceled(e)) {
          this.set(
            "connectionError",
            I18n.t("eth_providers.errors.connection_failed")
          );
        }
      } finally {
        this.set("isConnecting", false);
      }
    },

    async connectWalletConnect() {
      const provider = await this.ensureProvider();
      if (!provider) {
        return;
      }

      this.setProperties({ isConnecting: true, connectionError: null });

      try {
        const [account, message, signature, avatar] =
          await provider.connectWithWalletConnect();
        this.verifySignature(account, message, signature, avatar);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(e);
        if (!this.userCanceled(e)) {
          this.set(
            "connectionError",
            I18n.t("eth_providers.errors.connection_failed")
          );
        }
      } finally {
        this.set("isConnecting", false);
      }
    },
  },
});
