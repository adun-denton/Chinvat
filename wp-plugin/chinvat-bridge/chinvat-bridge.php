<?php
/**
 * Plugin Name:       Chinvat WP Bridge
 * Description:       Extended admin surface (options, theme file IO, RankMath, plugin management) for the Chinvat MCP labor hub. Exposed as WordPress Abilities and a thin REST handshake, gated by capability + a Developer Mode toggle.
 * Version:           0.4.0
 * Requires PHP:      7.4
 * Requires at least: 6.4
 * Author:            adun-denton
 * License:           MIT
 * Text Domain:       chinvat-bridge
 *
 * @package ChinvatBridge
 */

declare( strict_types = 1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'CHINVAT_BRIDGE_VERSION', '0.4.0' );
define( 'CHINVAT_BRIDGE_SCHEMA_VERSION', 3 );
define( 'CHINVAT_BRIDGE_REST_NS', 'chinvat-bridge/v1' );

// Back-compat override: defining this true in wp-config.php forces Developer
// Mode on regardless of the settings page.
if ( ! defined( 'CHINVAT_BRIDGE_ENABLE' ) ) {
	define( 'CHINVAT_BRIDGE_ENABLE', false );
}

require_once __DIR__ . '/includes/settings.php';
require_once __DIR__ . '/includes/security.php';
require_once __DIR__ . '/includes/abilities.php';
require_once __DIR__ . '/includes/abilities-db.php';
require_once __DIR__ . '/includes/rest-info.php';

/**
 * Categories must be registered on their own (earlier) hook, before any ability
 * that references them is registered on wp_abilities_api_init. Registering both
 * on the same hook makes every ability fail category validation (returns null).
 */
add_action( 'wp_abilities_api_categories_init', 'chinvat_bridge_register_categories' );
add_action( 'wp_abilities_api_categories_init', 'chinvat_bridge_register_db_categories' );
add_action( 'wp_abilities_api_init', 'chinvat_bridge_register_abilities' );
add_action( 'wp_abilities_api_init', 'chinvat_bridge_register_db_abilities' );

add_action( 'rest_api_init', 'chinvat_bridge_register_info_route' );
