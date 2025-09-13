# frozen_string_literal: true

require 'siwe'
module DiscourseSiwe
  class AuthController < ::ApplicationController
    def index
    end

    def message
      begin
        eth_account = params[:eth_account]
        raise Discourse::InvalidParameters.new(:eth_account) if eth_account.blank?

        # Normalize values
        domain = Discourse.base_url.dup
        domain.slice!("#{Discourse.base_protocol}://")
        chain_id = params[:chain_id].presence || "1"

        message = Siwe::Message.new(domain, eth_account, Discourse.base_url, "1", {
          issued_at: Time.now.utc.iso8601,
          statement: SiteSetting.siwe_statement,
          nonce: Siwe::Util.generate_nonce,
          chain_id: chain_id.to_s,
        })
        session[:nonce] = message.nonce

        render json: { message: message.prepare_message }
      rescue => e
        Rails.logger.warn("[discourse-siwe] message build failed: #{e.class}: #{e.message}")
        render json: { error: "siwe_message_failed" }, status: 500
      end
    end
  end
end
