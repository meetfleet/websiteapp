<?php
// Reject anything that isn't a POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Location: /support/');
    exit;
}

// Honeypot — bots fill this, humans don't
if (!empty($_POST['website'])) {
    header('Location: /support/');
    exit;
}

$name    = trim(strip_tags($_POST['name']    ?? ''));
$email   = trim(strip_tags($_POST['email']   ?? ''));
$topic   = trim(strip_tags($_POST['topic']   ?? 'General Inquiry'));
$message = trim(strip_tags($_POST['message'] ?? ''));

// Validate
if (
    empty($name) ||
    empty($email) ||
    empty($message) ||
    !filter_var($email, FILTER_VALIDATE_EMAIL)
) {
    header('Location: /support/?error=1');
    exit;
}

$to        = 'support@meetfleet.app';
$ticket_id = '#MF-' . strtoupper(substr(md5(uniqid(rand(), true)), 0, 6));
$subject   = '[Support ' . $ticket_id . '] ' . $topic . ' — ' . $name;
$timestamp = date('M j, Y \a\t g:i A T');
$first_name = explode(' ', $name)[0];

$is_science = (strpos($topic, 'Peer Review') !== false || strpos($topic, 'Research') !== false || strpos($topic, 'SAS') !== false || strpos($topic, 'Ascience') !== false);
$topic_class = $is_science ? 'topic-science' : 'topic-general';
$topic_icon  = $is_science ? '🔬' : '💬';

$template = file_get_contents(__DIR__ . '/email-template.html');

if ($template === false) {
    // Fallback plain text email if template file fails to load
    $body  = "Name:      $name\n";
    $body .= "Email:     $email\n";
    $body .= "Topic:     $topic\n";
    $body .= "Ticket:    $ticket_id\n";
    $body .= "Submitted: $timestamp\n";
    $body .= str_repeat('-', 40) . "\n\n";
    $body .= $message . "\n";

    $headers  = "From: Meetfleet Support <support@meetfleet.app>\r\n";
    $headers .= "Reply-To: $name <$email>\r\n";
    $headers .= "Content-Type: text/plain; charset=UTF-8\r\n";
    $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
} else {
    // Replace template variables
    $body = str_replace(
        ['{{TICKET_ID}}', '{{NAME}}', '{{FIRST_NAME}}', '{{EMAIL}}', '{{TOPIC_NAME}}', '{{TOPIC_CLASS}}', '{{TOPIC_ICON}}', '{{TOPIC_ENCODED}}', '{{TIMESTAMP}}', '{{MESSAGE}}'],
        [$ticket_id, htmlspecialchars($name), htmlspecialchars($first_name), htmlspecialchars($email), htmlspecialchars($topic), $topic_class, $topic_icon, urlencode($topic), $timestamp, nl2br(htmlspecialchars($message))],
        $template
    );

    $headers  = "From: Meetfleet Support <support@meetfleet.app>\r\n";
    $headers .= "Reply-To: $name <$email>\r\n";
    $headers .= "MIME-Version: 1.0\r\n";
    $headers .= "Content-Type: text/html; charset=UTF-8\r\n";
    $headers .= "X-Mailer: PHP/" . phpversion() . "\r\n";
}

$extra = '-f support@meetfleet.app';

if (mail($to, $subject, $body, $headers, $extra)) {
    header('Location: /support/success/');
    exit;
}

// Log failure
error_log('[Meetfleet Support] mail() failed for: ' . $email);
header('Location: /support/?error=1');
exit;
