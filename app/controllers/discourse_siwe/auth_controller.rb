# frozen_string_literal: true

require 'siwe'
module DiscourseSiwe
  class AuthController < ::ApplicationController
    private
    def to_checksum_address(addr)
      return addr if addr.blank?
      a = addr.to_s
      a = "0x#{a}" unless a.start_with?("0x", "0X")
      hex = a[2..].downcase
      return addr unless hex =~ /\A[0-9a-f]{40}\z/

      digest = nil
      begin
        require 'digest/keccak'
        digest = Digest::Keccak.hexdigest(hex, 256)
      rescue LoadError, NameError
        begin
          # Fallback to eth gem if available in runtime
          require 'eth'
          return Eth::Address.new(a).checksummed
        rescue StandardError
          return addr
        end
      end

      # With frozen_string_literal, ensure a mutable string
      result = +'0x'
      hex.chars.each_with_index do |c, i|
        if c =~ /[a-f]/
          n = digest[i].to_i(16)
          result << (n >= 8 ? c.upcase : c)
        else
          result << c
        end
      end
      result
    end

    public
    def index
      # Render the Discourse SPA shell so the Ember route can take over
      render html: "".html_safe, layout: "application"
    end

    def message
      begin
        eth_account = params[:eth_account]
        raise Discourse::InvalidParameters.new(:eth_account) if eth_account.blank?

        # Normalize values
        domain = Discourse.base_url.dup
        domain.slice!("#{Discourse.base_protocol}://")
        chain_id = params[:chain_id].presence || "1"

        address = to_checksum_address(eth_account)
        message = Siwe::Message.new(domain, address, Discourse.base_url, "1", {
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

    def accounts
      # Require a logged-in staff user (works with API key + Api-Username header)
      raise Discourse::InvalidAccess.new unless current_user&.staff?

      limit = (params[:limit] || 1000).to_i.clamp(1, 5000)
      offset = (params[:offset] || 0).to_i.clamp(0, 1_000_000_000)

      records = ::UserAssociatedAccount
        .where(provider_name: 'siwe')
        .joins("JOIN users ON users.id = user_associated_accounts.user_id")
        .order('user_associated_accounts.id ASC')
        .select("user_associated_accounts.user_id, users.username, users.email, user_associated_accounts.provider_uid AS address")
        .limit(limit)
        .offset(offset)

      render json: {
        count: records.length,
        offset: offset,
        limit: limit,
        data: records.map { |r| { user_id: r.user_id, username: r.username, email: r.email, address: r.address } }
      }
    end
  end
end
