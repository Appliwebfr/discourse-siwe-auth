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
        const Web3Modal = window.Web3Modal;
        const chains = [window.WagmiCore.mainnet, window.WagmiCore.polygon];
        const projectId = env.PROJECT_ID;

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

        const modal = new Web3Modal({ projectId, themeVariables: { '--w3m-z-index': '99999' } }, ethereumClient);
        this.web3Modal = modal;
        return modal;
    },

    async loadScripts() {
        return Promise.all([
            loadScript("/plugins/discourse-siwe/javascripts/web3bundle.min.js"),
        ]);
    },


    async signMessage(account) {
        const address = account.address;
        console.log("signMessage", account)
        let name, avatar;
        try {
            name = await this.ethereumClient.fetchEnsName({ address });
            if (name) {
                avatar = await this.ethereumClient.fetchEnsAvatar({ name });
            }
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error(error);
        }

        const { message } = await ajax('/discourse-siwe/message', {
            data: {
                eth_account: address,
                chain_id: await account.connector.getChainId(),
            }
        }).catch(popupAjaxError);

        try {
            const signature = await (
                await account.connector.getWalletClient()
            ).signMessage({
                account: address,
                message: message,
            });
            return [name || address, message, signature, avatar];

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

        // Resolve ENS details if client available
        let name, avatar;
        try {
            if (this.ethereumClient) {
                name = await this.ethereumClient.fetchEnsName({ address });
                if (name) {
                    avatar = await this.ethereumClient.fetchEnsAvatar({ name });
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
        const { message } = await ajax('/discourse-siwe/message', {
            data: { eth_account: address, chain_id }
        }).catch(popupAjaxError);

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

        return [name || address, message, signature, avatar];
    },

    async runSigningProcess(cb) {
        // Prefer injected wallets (MetaMask / Rabby) if available
        if (window.ethereum) {
            try {
                const res = await this.signWithInjected();
                return cb(res);
            } catch (e) {
                // eslint-disable-next-line no-console
                console.warn('Injected wallet flow failed, falling back to WalletConnect', e);
            }
        }

        // Fallback to WalletConnect via Web3Modal
        window.WagmiCore.watchAccount(async (account) => {
            if (account.isConnected && account.address) {
                this.connected = true;
                cb(await this.signMessage(account));
            }
        });

        this.web3Modal.openModal();
    },
});

export default Web3Modal;
