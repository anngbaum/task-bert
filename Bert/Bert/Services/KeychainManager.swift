import Foundation
import Security

enum KeychainManager {
    private static let service = "com.bert.api-keys"

    static func save(account: String, key: String) {
        let data = Data(key.utf8)

        // Delete existing item first
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)

        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
    }

    static func load(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    // Convenience accessors
    static var anthropicApiKey: String? {
        get { load(account: "anthropic") }
        set {
            if let key = newValue, !key.isEmpty {
                save(account: "anthropic", key: key)
            } else {
                delete(account: "anthropic")
            }
        }
    }

    static var openaiApiKey: String? {
        get { load(account: "openai") }
        set {
            if let key = newValue, !key.isEmpty {
                save(account: "openai", key: key)
            } else {
                delete(account: "openai")
            }
        }
    }
}
