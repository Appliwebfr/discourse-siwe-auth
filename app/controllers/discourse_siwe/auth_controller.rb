# frozen_string_literal: true

require 'siwe'
require 'uri'
module DiscourseSiwe
  class AuthController < ::ApplicationController
    skip_before_action :ensure_logged_in
    skip_before_action :redirect_to_login_if_required
    skip_before_action :check_xhr
    skip_before_action :verify_authenticity_token, only: [:message]
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

    def siwe_domain
      @siwe_domain ||= begin
        base_uri = URI.parse(Discourse.base_url)
        host = base_uri.host
        port = base_uri.port
        default_port = base_uri.scheme == 'https' ? 443 : 80

        if host.present?
          if port && port != default_port
            "#{host}:#{port}"
          else
            host
          end
        end
      rescue URI::InvalidURIError
        nil
      end
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
        domain = siwe_domain
        raise Discourse::InvalidParameters.new(:domain) if domain.blank?

        chain_id = params[:chain_id].presence || "1"

        address = to_checksum_address(eth_account)
        issued_at = (Time.zone || Time).now.utc
        ttl_seconds = 5 * 60
        message = Siwe::Message.new(domain, address, Discourse.base_url, "1", {
          issued_at: issued_at.iso8601,
          statement: SiteSetting.siwe_statement,
          nonce: Siwe::Util.generate_nonce,
          chain_id: chain_id.to_s,
          expiration_time: (issued_at + ttl_seconds).iso8601,
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
      include_email = ActiveModel::Type::Boolean.new.cast(params[:include_email])

      begin
        base = ::UserAssociatedAccount
          .where(provider_name: 'siwe')
          .joins("JOIN users ON users.id = user_associated_accounts.user_id")
          .order('user_associated_accounts.id ASC')

        select_clause = [
          'user_associated_accounts.user_id',
          'users.username',
          'user_associated_accounts.provider_uid AS address'
        ]
        select_clause << 'users.email' if include_email

        records = base
          .select(select_clause.join(', '))
          .limit(limit)
          .offset(offset)

        # Fetch group memberships for these users in one query
        user_ids = records.map(&:user_id).uniq
        groups_map = Hash.new { |h, k| h[k] = [] }
        if user_ids.present?
          ::GroupUser
            .joins(:group)
            .where(user_id: user_ids)
            .pluck('group_users.user_id', 'groups.id', 'groups.name')
            .each do |uid, gid, gname|
              groups_map[uid] << { id: gid, name: gname }
            end
        end

        data = records.map do |r|
          row = { user_id: r.user_id, username: r.username, address: r.address, groups: groups_map[r.user_id] || [] }
          row[:email] = r.email if include_email
          row
        end

        render json: { count: data.length, offset: offset, limit: limit, data: data }
      rescue => e
        Rails.logger.warn("[discourse-siwe] accounts failed: #{e.class}: #{e.message}\n#{e.backtrace&.first}")
        render json: { error: 'internal_error' }, status: 500
      end
    end
  end
end
