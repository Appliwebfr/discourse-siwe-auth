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
        eth_message_crlf = request.params['eth_message']
        eth_message = eth_message_crlf.encode(eth_message_crlf.encoding, universal_newline: true)
        eth_signature = request.params['eth_signature']
        siwe_message = ::Siwe::Message.from_message(eth_message)

        domain = Discourse.base_url
        domain.slice!("#{Discourse.base_protocol}://")
        if siwe_message.domain != domain
          return fail!("Invalid domain")
        end

        if siwe_message.nonce != session[:nonce]
          return fail!("Invalid nonce")
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
        session[:nonce] = nil
        super
      end
    end
  end
end
