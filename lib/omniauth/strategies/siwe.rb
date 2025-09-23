require 'uri'

module OmniAuth
  module Strategies
    class Siwe
      include OmniAuth::Strategy

      option :fields, %i[eth_message eth_account eth_signature]
      option :uid_field, :eth_account

      uid do
        # Prefer the verified address obtained from the SIWE message if available
        @verified_address || request.params[options.uid_field.to_s]
      end

      info do
        {
          # Do not prefill the user's display name with the address
          name: nil,
          image: request.params['eth_avatar']
        }
      end

      def request_phase
        query_string = env['QUERY_STRING']
        redirect "/discourse-siwe/auth?#{query_string}"
      end

      def callback_phase
        eth_message_raw = request.params['eth_message']
        eth_signature = request.params['eth_signature']

        return fail!(:missing_message) if eth_message_raw.blank?
        return fail!(:missing_signature) if eth_signature.blank?

        eth_message = eth_message_raw.encode(eth_message_raw.encoding, universal_newline: true)

        begin
          siwe_message = ::Siwe::Message.from_message(eth_message)
        rescue StandardError
          return fail!(:invalid_message)
        end

        unless valid_domain?(siwe_message.domain)
          return fail!(:invalid_domain)
        end

        unless valid_uri?(siwe_message.uri)
          return fail!(:invalid_uri)
        end

        expected_nonce = session.delete(:nonce)
        if expected_nonce.blank? || siwe_message.nonce != expected_nonce
          return fail!(:invalid_nonce)
        end

        failure_reason = nil
        begin
          siwe_message.validate(eth_signature)
        rescue Siwe::ExpiredMessage
          failure_reason = :expired_message
        rescue Siwe::NotValidMessage
          failure_reason = :invalid_message
        rescue Siwe::InvalidSignature
          failure_reason = :invalid_signature
        end

        return fail!(failure_reason) if failure_reason
        # At this point the signature is valid for the address inside the SIWE message.
        # Ensure the UID is the verified address (prevent spoofing via eth_account param).
        @verified_address = siwe_message.address
        begin
          # Override incoming param to keep downstream consistent
          request.update_param('eth_account', @verified_address)
        rescue StandardError
          request.params['eth_account'] = @verified_address
        end
        # Invalidate nonce to prevent replay within the same session
        super
      end

      private

      def valid_domain?(domain)
        expected = siwe_domain
        return false if expected.blank? || domain.blank?

        domain.casecmp(expected).zero?
      end

      def valid_uri?(uri_string)
        return false if uri_string.blank?

        message_uri = URI.parse(uri_string)
        base_uri = URI.parse(Discourse.base_url)

        same_host = message_uri.host == base_uri.host
        same_scheme = message_uri.scheme == base_uri.scheme
        same_port = message_uri.port == base_uri.port
        path_allowed = base_uri.path.blank? || message_uri.path.start_with?(base_uri.path)

        same_host && same_scheme && same_port && path_allowed
      rescue URI::InvalidURIError
        false
      end

      def siwe_domain
        @siwe_domain ||= begin
          base_uri = URI.parse(Discourse.base_url)
          host = base_uri.host
          port = base_uri.port
          default_port = base_uri.scheme == 'https' ? 443 : 80

          if port && port != default_port
            "#{host}:#{port}"
          else
            host
          end
        rescue URI::InvalidURIError
          nil
        end
      end
    end
  end
end
