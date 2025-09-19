import EmberObject from "@ember/object";
import {
    ajax
} from "discourse/lib/ajax";
import {
    popupAjaxError
} from "discourse/lib/ajax-error";
import loadScript from "discourse/lib/load-script";


const Web3Modal = EmberObject.extend({
    web3Modal: null,
    ethereumClient: null,
    async providerInit(env) {
        await this.loadScripts();
        const chains = [window.WagmiCore.mainnet, window.WagmiCore.polygon];
        const projectId = env.PROJECT_ID;
        this.projectId = projectId;

        // Build wagmi config using WalletConnect connectors and try to include injected if available
        const providers = [window.Web3ModalEth.w3mProvider({ projectId })];
        const { publicClient } = window.WagmiCore.configureChains(chains, providers);

        let connectors = window.Web3ModalEth.w3mConnectors({ projectId, version: 1, chains });

        try {
            // If wagmi exposes an InjectedConnector in the bundle, add it for MetaMask/Rabby
            const InjectedConnector = window.web3bundle?.wagmi?.InjectedConnector || window.WagmiCore?.InjectedConnector || null;
            if (InjectedConnector) {
                const injected = new InjectedConnector({ chains, options: { shimDisconnect: true } });
                console.log("InjectedConnector found", InjectedConnector)
                connectors = [...connectors, injected];
            }
        } catch (e) {
            // Non-fatal: fall back to WalletConnect-only
            // eslint-disable-next-line no-console
            console.warn('Injected connector not available in bundle, falling back to WalletConnect only');
        }

        const wagmiConfig = window.WagmiCore.createConfig({
            autoConnect: true,
            connectors,
            publicClient
        });
        const EthereumClient = window.Web3ModalEth.EthereumClient;
        const ethereumClient = new EthereumClient(wagmiConfig, chains);
        this.ethereumClient = ethereumClient;
        window.ethereumClient = ethereumClient;

        // Defer creating Web3Modal until we actually need the fallback
        this.web3Modal = null;
        return null;
    },

    async loadScripts() {
        return Promise.all([
            loadScript("/plugins/discourse-siwe/javascripts/web3bundle.min.js"),
        ]);
    },

    ensureModal() {
        if (!this.web3Modal) {
            const Web3Modal = window.Web3Modal;
            const modal = new Web3Modal({ projectId: this.projectId, themeVariables: { '--w3m-z-index': '99999' } }, this.ethereumClient);
            this.web3Modal = modal;
        }
        return this.web3Modal;
    },


    async signMessage(account) {
        const address = account.address;
        console.log("signMessage", account)
        let avatar;
        try {
            const ens = await this.ethereumClient.fetchEnsName({ address });
            if (ens) {
                avatar = await this.ethereumClient.fetchEnsAvatar({ name: ens });
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
        }

        const resp = await ajax('/discourse-siwe/message', {
            data: {
                eth_account: address,
                chain_id: await account.connector.getChainId(),
            }
        }).catch(popupAjaxError);

        if (!resp || !resp.message) {
            throw new Error('Failed to get SIWE message');
        }
        const { message } = resp;

        try {
            const signature = await (
                await account.connector.getWalletClient()
            ).signMessage({
                account: address,
                message: message,
            });
            // Always return the address as the first element; do not leak it as a suggested name
            return [address, message, signature, avatar];

        } catch (e) {
            throw e;
        }
    },

    async signWithInjected() {
        console.log("signWithInjected")
        const provider = window.ethereum;
        if (!provider) {
            throw new Error('No injected wallet available');
        }

        // Detect Rabby/MetaMask (optional, for future customization)
        const isRabby = !!provider.isRabby;
        const isMetaMask = !!provider.isMetaMask;

        // Request accounts
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        const address = accounts && accounts[0];
        console.log({ isRabby, isMetaMask, address })
        if (!address) {
            throw new Error('No account found from injected provider');
        }

        // Resolve ENS avatar if available
        let avatar;
        try {
            if (this.ethereumClient) {
                const ens = await this.ethereumClient.fetchEnsName({ address });
                if (ens) {
                    avatar = await this.ethereumClient.fetchEnsAvatar({ name: ens });
                }
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn('ENS lookup failed', e);
        }

        // Chain ID from provider (hex -> int)
        const chainIdHex = await provider.request({ method: 'eth_chainId' });
        const chain_id = typeof chainIdHex === 'string' ? parseInt(chainIdHex, 16) : chainIdHex;
        console.log({ chain_id })

        // Get SIWE message
        const resp = await ajax('/discourse-siwe/message', {
            data: { eth_account: address, chain_id }
        }).catch(popupAjaxError);

        if (!resp || !resp.message) {
            throw new Error('Failed to get SIWE message');
        }
        const { message } = resp;

        console.log({ message })

        // Sign via personal_sign
        let signature;
        try {
            signature = await provider.request({ method: 'personal_sign', params: [message, address] });
        } catch (e) {
            // Some providers expect reversed params order
            signature = await provider.request({ method: 'personal_sign', params: [address, message] });
        }

        console.log({ signature })

        // Flag used wallet for telemetry/debugging if needed
        if (isRabby) {
            // eslint-disable-next-line no-console
            console.debug('Signed with Rabby');
        } else if (isMetaMask) {
            // eslint-disable-next-line no-console
            console.debug('Signed with MetaMask');
        }

        // Always return the address as the first element; do not leak it as a suggested name
        return [address, message, signature, avatar];
    },

    async connectWithWalletConnect() {
        return new Promise((resolve, reject) => {
            let unwatch;
            let unsubscribeModal;
            let finished = false;

            const cleanup = () => {
                if (unwatch) {
                    try {
                        unwatch();
                    } catch (unwatchError) {
                        // eslint-disable-next-line no-console
                        console.warn('Failed to unwatch WalletConnect account', unwatchError);
                    }
                    unwatch = null;
                }

                if (unsubscribeModal) {
                    try {
                        unsubscribeModal();
                    } catch (unsubscribeError) {
                        // eslint-disable-next-line no-console
                        console.warn('Failed to unsubscribe WalletConnect modal watcher', unsubscribeError);
                    }
                    unsubscribeModal = null;
                }
            };

            const finalize = (result, error) => {
                if (finished) {
                    return;
                }
                finished = true;
                cleanup();

                if (this.web3Modal && typeof this.web3Modal.closeModal === 'function') {
                    try {
                        this.web3Modal.closeModal();
                    } catch (closeError) {
                        // eslint-disable-next-line no-console
                        console.warn('Failed to close WalletConnect modal', closeError);
                    }
                }

                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            };

            try {
                unwatch = window.WagmiCore.watchAccount(async (account) => {
                    if (account.isConnected && account.address) {
                        try {
                            const signed = await this.signMessage(account);
                            finalize(signed, null);
                        } catch (signError) {
                            finalize(null, signError);
                        }
                    }
                });
            } catch (e) {
                finalize(null, e);
                return;
            }

            const modal = this.ensureModal();

            if (modal && typeof modal.subscribeModal === 'function') {
                try {
                    unsubscribeModal = modal.subscribeModal((state) => {
                        if (!state.open) {
                            const error = new Error('WalletConnect modal closed');
                            error.canceled = true;
                            finalize(null, error);
                        }
                    });
                } catch (subscribeError) {
                    // eslint-disable-next-line no-console
                    console.warn('Failed to subscribe to WalletConnect modal state', subscribeError);
                }
            }

            try {
                modal.openModal();
            } catch (e) {
                finalize(null, e);
            }
        });
    },
});

export default Web3Modal;
